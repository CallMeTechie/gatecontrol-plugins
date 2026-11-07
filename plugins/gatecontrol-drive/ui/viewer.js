/* Drive (gatecontrol-drive) — the viewer of pictures and videos in the portal tab (since 1.21.0): window.DriveViewer.
 *
 * A click on a picture or a video — in "Dateien", in the search and in "Fotos" — opens it full size over the page,
 * no download first: the pictures and videos of the same folder (or of the photos shown) one after the other with the
 * arrows, the arrow keys or a swipe; pictures zoom (mouse wheel, +/−, a double click, two fingers) and move when zoomed;
 * videos play right here (<video> with the browser's controls — play / pause, seek, sound, full screen where the page
 * allows it) from the signed media URL of GET nodes/<id>/content: GateControl answers Range requests, so the browser
 * only loads what it plays. A video the browser cannot play (often MKV or HEVC) says so, with "Herunterladen".
 * The place in a video is kept while the tab is open (the frame has no storage).
 * Above: the name, "3 / 12", Herunterladen, Teilen (who may), Details (size, type, date, who, where it came from) and the
 * file's menu (the same as in the list). The virus scan: a blocked file shows its reason and loads nothing; a file
 * marked as malware only after "Trotzdem ansehen".
 *
 * portal.js calls DriveViewer.attach(ui) with its helpers and asks it: viewable(n) → 'image' | 'video' | null,
 * open(list, index), save(n, content) (a picture or video as a download: GC.mediaBytes, at most SAVE_MAX), isOpen().
 */
(function () {
  'use strict';

  var READ = 16 * 1024 * 1024;           // GC.mediaBytes: at most 16 MiB a call
  var SAVE_MAX = 512 * 1024 * 1024;      // larger files: "Speichern unter" of the browser, or the apps
  var ZOOM_MAX = 8;
  var SWIPE_PX = 60;
  var KEEP_S = 5;                        // a place in a video is kept after 5 s, not within the last 5 s
  // types a browser rarely plays: the hint first, "Trotzdem abspielen" tries
  var RARE_VIDEO = /^video\/(x-matroska|x-msvideo|avi|msvideo|x-ms-wmv|x-ms-asf|x-flv|mpeg|x-mpeg|3gpp2?|x-m4v-hevc|hevc|h265)$/;

  function attach(U) {
    var T = U.T;
    var h = U.h;
    var icon = U.icon;
    var ibtn = U.ibtn;
    var btn = U.btn;
    var api = U.api;
    var $ = function (id) { return document.getElementById(id); };

    var st = {
      el: null,          // the overlay
      list: [],
      i: 0,
      zoom: null,        // { z, x, y } of the picture shown
      media: null,       // the <img> / <video> shown
      info: false,       // the details shown
      allowed: {},       // node id → true: marked as malware, "Trotzdem ansehen"
      tried: {},         // node id → true: a rare video type, "Trotzdem abspielen"
      pos: {},           // "<id>:<rev>" → seconds: where a video was left
      seq: 0,
      ptr: {},           // pointer id → { x, y } (zoom with two fingers, move, swipe)
      gesture: null,
    };

    function viewable(n) {
      if (!n || n.isDir || n.encrypted) return null;
      var m = String(n.mime || '');
      if (/^image\//.test(m)) return 'image';
      if (/^video\//.test(m)) return 'video';
      return null;
    }
    function isOpen() { return !!st.el; }
    function dialogOpen() { var d = $('dp-dialog'); return !!(d && !d.hidden); }
    function held(n) { return !!(n && n.scan && n.scan.blocked); }
    function marked(n) { return !!(n && n.scan && n.scan.state === 'infected' && !n.scan.blocked); }
    function cls(el, name, on) {
      var c = String(el.className || '').split(/\s+/).filter(function (x) { return x && x !== name; });
      if (on) c.push(name);
      el.className = c.join(' ');
    }

    // ── open / close ───────────────────────────────────────

    function open(list, index) {
      var items = (Array.isArray(list) ? list : []).filter(viewable);
      if (!items.length) return;
      var want = list[index] || items[0];
      var at = items.indexOf(want);
      if (at < 0) at = items.map(function (x) { return x.id; }).indexOf(want && want.id);
      if (!st.el) build();
      st.list = items;
      st.i = at < 0 ? 0 : at;
      show();
    }

    function close() {
      if (!st.el) return;
      stopMedia();
      if (document.fullscreenElement && document.exitFullscreen) { try { document.exitFullscreen(); } catch (e) { /* not in full screen */ } }
      var el = st.el;
      st.el = null;
      st.seq++;
      if (el.parentNode) el.parentNode.removeChild(el);
      if (st.app) { st.app.hidden = false; st.app = null; }
      if (st.back && st.back.focus) { try { st.back.focus(); } catch (e) { /* gone */ } }
      if (st.back && st.back.scrollIntoView) { try { st.back.scrollIntoView({ block: 'nearest' }); } catch (e) { /* not here */ } }
    }

    function build() {
      st.back = document.activeElement;
      st.title = h('h3', { class: 'dp-vw-title' });
      st.sub = h('p', { class: 'dp-vw-sub' });
      st.tools = h('div', { class: 'dp-vw-tools' });
      st.stage = h('div', { class: 'dp-vw-stage', attrs: { 'aria-live': 'polite' } });
      st.prev = h('button', { type: 'button', class: 'dp-ib dp-vw-nav is-prev', attrs: { 'aria-label': T('p.vw_prev'), title: T('p.vw_prev') }, on: { click: function () { go(-1); } } }, icon('chevLeft', 22));
      st.next = h('button', { type: 'button', class: 'dp-ib dp-vw-nav is-next', attrs: { 'aria-label': T('p.vw_next'), title: T('p.vw_next') }, on: { click: function () { go(1); } } }, icon('chevRight', 22));
      st.side = h('aside', { class: 'dp-vw-info', attrs: { 'aria-label': T('p.vw_details') } });
      st.side.hidden = !st.info;
      st.el = h('div', { class: 'dp-vw', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': T('p.vw_title') } }, [
        h('div', { class: 'dp-vw-head' }, [
          ibtn('close', T('p.close'), close, { cls: 'dp-vw-ib' }),
          h('div', { class: 'dp-vw-names' }, [st.title, st.sub]),
          st.tools,
        ]),
        h('div', { class: 'dp-vw-body' }, [h('div', { class: 'dp-vw-main' }, [st.prev, st.stage, st.next]), st.side]),
      ]);
      bindGestures(st.stage);
      // in the page's flow, as high as the frame may be without the page scrolling (--gc-viewport-height): the list
      // below goes away meanwhile (the frame grows with its content — an overlay would sit somewhere in a long list)
      var app = $('dp-app');
      st.app = app && !app.hidden ? app : null;
      if (st.app) st.app.hidden = true;
      ($('dp-root') || document.body).appendChild(st.el);
    }

    function go(d) {
      var j = st.i + d;
      if (j < 0 || j >= st.list.length) return;
      st.i = j;
      show();
    }

    // ── one picture or video ───────────────────────────────

    function stopMedia() {
      var v = st.media;
      if (v && v.localName === 'video') {
        keepPlace(v);
        try { v.pause(); } catch (e) { /* not playing */ }
        v.removeAttribute('src');
        try { if (v.load) v.load(); } catch (e) { /* nothing loaded */ }
      }
      st.media = null;
      st.zoom = null;
    }

    function show() {
      var n = st.list[st.i];
      var seq = ++st.seq;
      stopMedia();
      while (st.stage.firstChild) st.stage.removeChild(st.stage.firstChild);
      cls(st.stage, 'is-zoomed', false);
      st.title.textContent = U.nm(n);
      st.title.setAttribute('title', U.nm(n));
      st.sub.textContent = [st.list.length > 1 ? T('p.vw_count', { n: st.i + 1, total: st.list.length }) : '', U.fmtSize(n.size), U.fmtDate(n.mtime || n.updatedAt)].filter(Boolean).join(' · ');
      st.prev.disabled = st.i === 0;
      st.next.disabled = st.i >= st.list.length - 1;
      st.prev.hidden = st.next.hidden = st.list.length < 2;
      tools(n);
      details(n);
      var kind = viewable(n);
      // the virus scan: a blocked file loads nothing; a marked one only when asked
      if (held(n)) { stageNote(n, [U.scanNote(n)]); return; }
      if (marked(n) && !st.allowed[n.id]) {
        stageNote(n, [U.scanNote(n), h('div', { class: 'dp-actions' }, btn(T('p.vw_show_anyway'), function () { st.allowed[n.id] = true; show(); }, { danger: true, icon: 'eye' }))]);
        return;
      }
      if (kind === 'image') showImage(n, seq);
      else showVideo(n, seq);
    }

    function stageNote(n, kids) {
      st.stage.appendChild(h('div', { class: 'dp-vw-note' }, [h('span', { class: 'dp-vw-big' }, icon(viewable(n) === 'video' ? 'video' : 'image', 44))].concat(kids)));
    }

    function busy() { return h('div', { class: 'dp-vw-busy', attrs: { role: 'status' } }, [h('span', { class: 'dp-spin', attrs: { 'aria-hidden': 'true' } }), h('span', { text: T('p.vw_loading') })]); }

    function content(n) { return api('GET', 'nodes/' + n.id + '/content'); }

    function failed(n, seq, e) {
      if (seq !== st.seq) return;
      while (st.stage.firstChild) st.stage.removeChild(st.stage.firstChild);
      stageNote(n, [h('p', { class: 'dp-err', attrs: { role: 'alert' }, text: typeof e === 'string' ? e : U.errText(e) })]);
    }

    function showImage(n, seq) {
      // the large preview at once (GateControl ≥ 1.208.0), the original over it once loaded; HEIC: the preview only
      var low = n.preview && (n.preview.largeUrl || n.preview.url);
      var heic = /^image\/hei[cf]/.test(String(n.mime || ''));
      var img = h('img', { class: 'dp-vw-img', attrs: { alt: U.nm(n), draggable: 'false' } });
      st.media = img;
      st.zoom = { z: 1, x: 0, y: 0 };
      if (low) img.setAttribute('src', low);
      else st.stage.appendChild(busy());
      st.stage.appendChild(img);
      if (heic && low) return;
      content(n).then(function (r) {
        if (seq !== st.seq) return;
        var big = h('img', { attrs: { alt: '' } });
        big.addEventListener('load', function () {
          if (seq !== st.seq) return;
          img.setAttribute('src', r.url);
          var b = st.stage.querySelector('.dp-vw-busy');
          if (b && b.parentNode) b.parentNode.removeChild(b);
        });
        big.addEventListener('error', function () {
          if (seq !== st.seq || low) return;
          failed(n, seq, T('p.no_preview'));
        });
        big.setAttribute('src', r.url);
      }, function (e) { if (!low) failed(n, seq, e); });
    }

    function playable(v, mime) {
      if (!v || typeof v.canPlayType !== 'function') return true;
      return v.canPlayType(mime) !== '' || !RARE_VIDEO.test(mime);
    }

    function showVideo(n, seq) {
      var mime = String(n.mime || '').toLowerCase();
      var poster = n.preview && (n.preview.largeUrl || n.preview.url);
      var v = h('video', { class: 'dp-vw-video', attrs: { controls: true, preload: 'metadata', playsinline: true } });
      if (poster) v.setAttribute('poster', poster);
      if (!playable(v, mime) && !st.tried[n.id]) { cantPlay(n, true); return; }
      st.media = v;
      st.stage.appendChild(v);
      var wait = busy();
      st.stage.appendChild(wait);
      var gone = function () { if (wait.parentNode) wait.parentNode.removeChild(wait); };
      v.addEventListener('loadedmetadata', function () {
        gone();
        var at = st.pos[placeKey(n)];
        if (at && isFinite(v.duration) && at < v.duration - KEEP_S) { try { v.currentTime = at; } catch (e) { /* not seekable */ } }
      });
      v.addEventListener('loadeddata', function () {
        // a video whose picture the browser cannot decode (e.g. HEVC) plays sound only: say so
        if (seq === st.seq && v.videoWidth === 0 && v.videoHeight === 0 && !/^audio\//.test(mime)) note(T('p.vw_no_picture'));
      });
      v.addEventListener('timeupdate', function () { keepPlace(v); });
      v.addEventListener('ended', function () { delete st.pos[placeKey(n)]; });
      v.addEventListener('error', function () { if (seq === st.seq && v.getAttribute('src')) cantPlay(n, false); });
      content(n).then(function (r) {
        if (seq !== st.seq) return;
        v.setAttribute('src', r.url);
        v.dpKey = placeKey(n);
        var p = v.play && v.play();
        if (p && p.catch) p.catch(function () { /* the browser wants a click first */ });
      }, function (e) { failed(n, seq, e); });
    }

    function note(text) {
      if (st.stage.querySelector('.dp-vw-hint')) return;
      st.stage.appendChild(h('p', { class: 'dp-vw-hint', attrs: { role: 'note' }, text: text }));
    }

    function cantPlay(n, before) {
      stopMedia();
      while (st.stage.firstChild) st.stage.removeChild(st.stage.firstChild);
      var acts = [btn(T('p.download'), function () { save(n); }, { primary: true, icon: 'download' })];
      if (before) acts.push(btn(T('p.vw_try'), function () { st.tried[n.id] = true; show(); }, { icon: 'video' }));
      stageNote(n, [h('p', { class: 'dp-vw-hint', text: T('p.vw_cannot_play', { type: typeName(n) }) }), h('div', { class: 'dp-actions' }, acts)]);
    }

    function typeName(n) {
      var i = String(n.name || '').lastIndexOf('.');
      return i > 0 ? String(n.name).slice(i + 1).toUpperCase() : String(n.mime || '');
    }

    function placeKey(n) { return n.id + ':' + (n.rev || 0); }
    function keepPlace(v) {
      if (!v || !v.dpKey) return;
      var t = Number(v.currentTime) || 0;
      var d = Number(v.duration) || 0;
      if (t > KEEP_S && (!d || t < d - KEEP_S)) st.pos[v.dpKey] = t;
      else if (d && t >= d - KEEP_S) delete st.pos[v.dpKey];
    }

    // ── the bar above, the details ─────────────────────────

    function tools(n) {
      var box = st.tools;
      while (box.firstChild) box.removeChild(box.firstChild);
      var blocked = held(n);
      var image = viewable(n) === 'image';
      if (image && !blocked) {
        box.appendChild(ibtn('zoomOut', T('p.vw_zoom_out'), function () { zoomBy(1 / 1.5); }, { cls: 'dp-vw-ib' }));
        box.appendChild(ibtn('zoomIn', T('p.vw_zoom_in'), function () { zoomBy(1.5); }, { cls: 'dp-vw-ib' }));
      }
      if (document.fullscreenEnabled && st.el && st.el.requestFullscreen) box.appendChild(ibtn('expand', T('p.vw_fullscreen'), fullscreen, { cls: 'dp-vw-ib' }));
      box.appendChild(ibtn('info', T('p.vw_details'), function () { st.info = !st.info; st.side.hidden = !st.info; tools(n); }, { cls: 'dp-vw-ib', pressed: st.info }));
      if (!blocked) box.appendChild(ibtn('download', T('p.download'), function () { save(n); }, { cls: 'dp-vw-ib' }));
      if (!blocked && n.mediaId && U.canWriteNode(n)) box.appendChild(ibtn('share', T('p.share'), function () { U.share(n); }, { cls: 'dp-vw-ib' }));
      box.appendChild(ibtn('more', T('p.actions_for', { name: U.nm(n) }), function () { U.actions(n); }, { cls: 'dp-vw-ib' }));
    }

    function details(n) {
      var box = st.side;
      while (box.firstChild) box.removeChild(box.firstChild);
      var by = n.updatedBy != null ? U.personName(n.updatedBy) : '';
      var rows = [
        [T('p.vw_name'), U.nm(n)],
        [T('p.vw_size'), U.fmtSize(n.size)],
        [T('p.vw_type'), n.mime || ''],
        [n.takenAt ? T('p.vw_taken') : T('p.vw_changed'), U.fmtDate(n.takenAt || n.mtime || n.updatedAt)],
        [T('p.vw_by'), by],
        [T('p.vw_where'), U.whereOf(n)],
      ].filter(function (x) { return x[1]; });
      box.appendChild(h('h4', { text: T('p.vw_details') }));
      box.appendChild(h('dl', { class: 'dp-facts' }, rows.map(function (x) { return [h('dt', { text: x[0] }), h('dd', { text: x[1] })]; })));
      if (n.source && n.source.label) box.appendChild(h('p', { class: 'dp-hint dp-source', text: n.source.label }));
      var s = U.scanNote(n);
      if (s) box.appendChild(s);
      if (n.parentId != null && U.showFolder) box.appendChild(btn(T('p.show_in_folder'), function () { close(); U.showFolder(n); }, { small: true, icon: 'folder' }));
    }

    function fullscreen() {
      if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen(); return; }
      // a video alone in full screen (its controls stay), a picture with the viewer around it
      var el = st.media && st.media.localName === 'video' && st.media.requestFullscreen ? st.media : st.el;
      try {
        var p = el.requestFullscreen();
        if (p && p.catch) p.catch(function () { U.toast(T('p.vw_no_fullscreen'), 'error'); });
      } catch (e) { U.toast(T('p.vw_no_fullscreen'), 'error'); }
    }

    // ── zoom, move, swipe ──────────────────────────────────

    function apply() {
      var img = st.media;
      var z = st.zoom;
      if (!img || !z) return;
      if (z.z <= 1) { z.z = 1; z.x = 0; z.y = 0; }
      img.style.transform = z.z === 1 ? '' : 'translate(' + Math.round(z.x) + 'px,' + Math.round(z.y) + 'px) scale(' + (Math.round(z.z * 100) / 100) + ')';
      cls(st.stage, 'is-zoomed', z.z > 1);
    }
    function zoomBy(f, cx, cy) {
      var z = st.zoom;
      if (!z) return;
      var nz = Math.max(1, Math.min(ZOOM_MAX, z.z * f));
      // about the point under the pointer (cx, cy from the middle of the stage)
      var k = nz / z.z;
      if (cx != null) { z.x = cx - (cx - z.x) * k; z.y = cy - (cy - z.y) * k; } else { z.x *= k; z.y *= k; }
      z.z = nz;
      apply();
    }
    function fromMiddle(ev) {
      var r = st.stage.getBoundingClientRect ? st.stage.getBoundingClientRect() : null;
      if (!r) return [null, null];
      return [ev.clientX - (r.left + r.width / 2), ev.clientY - (r.top + r.height / 2)];
    }

    function bindGestures(el) {
      el.addEventListener('wheel', function (ev) {
        if (!st.zoom) return;
        if (ev.preventDefault) ev.preventDefault();
        var c = fromMiddle(ev);
        zoomBy(ev.deltaY < 0 ? 1.2 : 1 / 1.2, c[0], c[1]);
      });
      el.addEventListener('dblclick', function (ev) {
        if (!st.zoom) return;
        var c = fromMiddle(ev);
        if (st.zoom.z > 1) { st.zoom.z = 1; apply(); } else zoomBy(2.5, c[0], c[1]);
      });
      el.addEventListener('pointerdown', function (ev) {
        if (st.media && st.media.localName === 'video') return;
        st.ptr[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
        var ids = Object.keys(st.ptr);
        if (ids.length === 2) {
          var a = st.ptr[ids[0]];
          var b = st.ptr[ids[1]];
          st.gesture = { pinch: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: st.zoom ? st.zoom.z : 1 };
        } else st.gesture = { x: ev.clientX, y: ev.clientY, sx: st.zoom ? st.zoom.x : 0, sy: st.zoom ? st.zoom.y : 0, moved: false };
        if (el.setPointerCapture) { try { el.setPointerCapture(ev.pointerId); } catch (e) { /* gone */ } }
      });
      el.addEventListener('pointermove', function (ev) {
        var p = st.ptr[ev.pointerId];
        var g = st.gesture;
        if (!p || !g) return;
        p.x = ev.clientX;
        p.y = ev.clientY;
        var ids = Object.keys(st.ptr);
        if (g.pinch && ids.length === 2 && st.zoom) {
          var a = st.ptr[ids[0]];
          var b = st.ptr[ids[1]];
          var f = (Math.hypot(a.x - b.x, a.y - b.y) || 1) / g.pinch;
          st.zoom.z = Math.max(1, Math.min(ZOOM_MAX, g.z * f));
          apply();
          return;
        }
        if (g.pinch) return;
        g.moved = g.moved || Math.abs(ev.clientX - g.x) > 6 || Math.abs(ev.clientY - g.y) > 6;
        if (st.zoom && st.zoom.z > 1) { st.zoom.x = g.sx + (ev.clientX - g.x); st.zoom.y = g.sy + (ev.clientY - g.y); apply(); }
      });
      var end = function (ev) {
        var g = st.gesture;
        delete st.ptr[ev.pointerId];
        if (Object.keys(st.ptr).length) return;
        st.gesture = null;
        // a swipe: the next or the one before (not while zoomed)
        if (g && !g.pinch && (!st.zoom || st.zoom.z === 1)) {
          var dx = ev.clientX - g.x;
          var dy = ev.clientY - g.y;
          if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
        }
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    }

    // the keys: ← → the next, Esc closes, + − 0 zoom, F full screen, I details (not while a dialog is above)
    document.addEventListener('keydown', function (ev) {
      if (!st.el || !ev || ev.dpHandled || dialogOpen()) return;
      var t = ev.target && String(ev.target.localName || '').toLowerCase();
      if (t === 'input' || t === 'textarea' || t === 'select') return;
      var key = String(ev.key || '');
      var video = st.media && st.media.localName === 'video';
      var stop = function () { if (ev.preventDefault) ev.preventDefault(); ev.dpHandled = true; };
      if (key === 'Escape') { stop(); if (document.fullscreenElement) return; close(); return; }
      // the video's own keys (space, ← → seek) while it has the focus
      if (video && ev.target === st.media) { ev.dpHandled = true; return; }
      if (key === 'ArrowLeft') { stop(); go(-1); return; }
      if (key === 'ArrowRight') { stop(); go(1); return; }
      if ((key === '+' || key === '=') && st.zoom) { stop(); zoomBy(1.5); return; }
      if (key === '-' && st.zoom) { stop(); zoomBy(1 / 1.5); return; }
      if (key === '0' && st.zoom) { stop(); st.zoom.z = 1; apply(); return; }
      if ((key === 'f' || key === 'F') && document.fullscreenEnabled) { stop(); fullscreen(); return; }
      if (key === 'i' || key === 'I') { stop(); st.info = !st.info; st.side.hidden = !st.info; tools(st.list[st.i]); return; }
      // nothing else reaches the list below (Entf, Strg+A …)
      ev.dpHandled = true;
    });

    // ── download ───────────────────────────────────────────

    /** A picture or video as a download (the frame cannot link to it: GateControl shows those inline). */
    function save(n, got, anyway) {
      if (held(n)) { U.toast(((U.scanInfo(n) || {}).note) || T('p.scan_blocked'), 'error'); return; }
      if (marked(n) && !anyway && !st.allowed[n.id]) {
        U.confirmDialog(T('p.scan_warn_title'), T('p.scan_note_marked', { finding: n.scan.finding || T('p.scan_unknown') }), T('p.scan_download_anyway'), function () {
          save(n, got, true);
          return Promise.resolve();
        }, true);
        return;
      }
      if (!window.GC || typeof window.GC.mediaBytes !== 'function' || n.size > SAVE_MAX) { U.toast(T('p.vw_save_large'), 'error'); return; }
      U.toast(T('p.vw_saving', { name: U.nm(n) }));
      (got ? Promise.resolve(got) : content(n)).then(function (c) {
        var parts = [];
        var size = Number(c.size) || 0;
        var step = function (at) {
          if (at >= size) return Promise.resolve();
          var end = Math.min(size, at + READ) - 1;
          return window.GC.mediaBytes(c.url, { start: at, end: end }).then(function (x) { parts.push(new Uint8Array(x.data)); return step(end + 1); });
        };
        return step(0).then(function () {
          var url = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }));
          var a = h('a', { attrs: { href: url, download: c.name || U.nm(n), rel: 'noopener' } });
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        });
      }).catch(function (e) { U.toast(U.errText(e), 'error'); });
    }

    return { viewable: viewable, open: open, close: close, save: save, isOpen: isOpen };
  }

  window.DriveViewer = { attach: attach };
}());
