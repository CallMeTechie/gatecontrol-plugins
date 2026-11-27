/* Page "Umwandeln": the list of videos that do not play everywhere (1.5.0) and, since 1.6.0, converting them through
   the service "umwandeln" of a gateway — queue for the night window, "Jetzt umwandeln", the running job (pause,
   cancel), the check view ("geprüft"), the trash (restore, delete now, empty) and the settings (window, pause while
   somebody watches, trash days, quality). Without a gateway that can convert the page only lists, without a button
   that would pretend otherwise. */
(function () {
  'use strict';
  var P = window.MD;
  var T = P.T, el = P.el, $ = P.$;
  var SVG = 'http://www.w3.org/2000/svg';
  var ICONS = {
    phone: ['M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M11 18h2'],
    tv: ['M3 6h18v11H3z', 'M8 21h8', 'M12 17v4'],
    windows: ['M3 4h18v12H3z', 'M9 20h6', 'M12 16v4'],
    moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'],
    x: ['M6 6l12 12', 'M18 6L6 18'],
    pause: ['M9 5v14', 'M15 5v14'],
    play: ['M8 5l11 7-11 7z'],
    gear: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
    trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
    undo: ['M9 14L4 9l5-5', 'M4 9h11a5 5 0 0 1 0 10h-3'],
    check: ['M5 12l5 5L20 7'],
    more: ['M12 5h.01', 'M12 12h.01', 'M12 19h.01'],
  };
  var MARK = { yes: '✓', maybe: '~', no: '✕' };
  var LEVEL_TONE = { convert: 'crit', hint: 'warn', info: null };
  var LEVEL_RANK = { convert: 0, hint: 1, info: 2 };
  var STEP = 100;
  var ui = { filter: 'all', sort: 'level', q: '', shown: STEP, sel: {} };
  var data = null;
  var timer = null;
  var LOCALE = P.CTX.lang === 'en' ? 'en-GB' : 'de-DE';

  function icon(kind) {
    var s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'md-ic');
    ICONS[kind].forEach(function (d) { var p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d); s.appendChild(p); });
    return s;
  }
  function size(b) {
    if (b == null) return '–';
    if (b >= 1e12) return (b / 1e12).toLocaleString(LOCALE, { maximumFractionDigits: 1 }) + ' TB';
    if (b >= 1e9) return (b / 1e9).toLocaleString(LOCALE, { maximumFractionDigits: 1 }) + ' GB';
    return Math.max(1, Math.round(b / 1e6)).toLocaleString(LOCALE) + ' MB';
  }
  function time(min) {
    if (min == null) return '–';
    var h = Math.floor(min / 60);
    return h ? T('cv.time_h', { h: h, m: min % 60 }) : T('cv.time_m', { m: min });
  }
  function clock(sec) {
    if (sec == null) return '–';
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var ss = (Math.round(s * 100) / 100).toFixed(2);
    if (s < 10) ss = '0' + ss;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + ss.replace('.', LOCALE === 'de-DE' ? ',' : '.');
  }
  function date(v) {
    if (!v) return '–';
    var d = new Date(v);
    return isNaN(d.getTime()) ? '–' : d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function hm(v) {
    var d = new Date(v);
    return isNaN(d.getTime()) ? '–' : d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  }
  function daysUntil(v) {
    var d = Date.parse(v);
    return isNaN(d) ? null : Math.max(0, Math.ceil((d - Date.now()) / 86400000));
  }
  function pad(n) { return n == null ? '?' : (n < 10 ? '0' + n : String(n)); }
  function title(it) {
    if (it.kind === 'Episode') return (it.series || '?') + ' · S' + pad(it.season) + 'E' + pad(it.episode) + ' „' + it.name + '“';
    return it.name + (it.year ? ' (' + it.year + ')' : '');
  }
  function pill(text, tone) { return el('span', { class: 'md-pill', 'data-tone': tone || null, text: text }); }
  function devices(d) {
    return el('span', { class: 'md-devs' }, ['phone', 'tv', 'windows'].map(function (k) {
      var v = (d && d[k]) || 'yes';
      var label = T('cv.dev.' + k) + ': ' + T('cv.devval.' + v);
      return el('span', { class: 'md-dev', 'data-v': v, title: label, 'aria-label': label, role: 'img' }, [icon(k), el('span', { 'aria-hidden': 'true', text: MARK[v] })]);
    }));
  }
  function conv(it) { return it.conv || { state: 'none' }; }
  function minutesOf(it) {
    var c = conv(it);
    if (c.minutes != null) return c.minutes;
    return it.estimate && it.estimate.minutes != null ? it.estimate.minutes : null;
  }
  function sizeText(it) {
    var e = it.estimate;
    if (e && e.kind === 'encode' && e.size != null) return size(it.size) + ' → ≈ ' + size(e.size);
    return size(it.size);
  }
  function minutesText(it) {
    var e = it.estimate;
    if (!e) return '–';
    if (e.kind === 'remux') return T('cv.remux');
    var m = minutesOf(it);
    return m == null ? '–' : '≈ ' + time(m);
  }
  function api(method, path, body) { return P.api(method, path, body); }
  function key(it) { return { sourceId: it.sourceId, id: it.id }; }
  function errText(code) { return T('cv.err.' + code) === 'cv.err.' + code ? code : T('cv.err.' + code); }

  // ── actions ──
  function act(p, okText) {
    return p.then(function (r) { if (okText) P.toast(okText); return load().then(function () { return r; }); }).catch(function (e) { P.warn(e); return load(); });
  }
  function queue(list, now) {
    return act(api('POST', 'admin/convert/queue', { items: list.map(key), now: !!now }).then(function (r) {
      ui.sel = {};
      if (r.skipped && r.skipped.length && !r.queued.length) throw { data: { error: T('cv.why.q.' + r.skipped[0].reason) } };
      return r;
    }), now ? T('cv.toast_now') : T('cv.toast_queued'));
  }
  function fileAct(it, action, okText) { return act(api('POST', 'admin/convert/file', { sourceId: it.sourceId, id: it.id, action: action }), okText); }
  function menu(anchor, items) {
    var old = $('.md-menu');
    if (old) old.remove();
    var m = el('div', { class: 'md-menu', role: 'menu' }, items.map(function (x) {
      return el('button', { type: 'button', role: 'menuitem', class: 'md-menu-i', text: x.label, on: { click: function () { m.remove(); x.run(); } } });
    }));
    anchor.parentNode.appendChild(m);
    setTimeout(function () {
      var close = function (ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('click', close); } };
      document.addEventListener('click', close);
    }, 0);
    var first = m.querySelector('button');
    if (first) first.focus();
  }

  // ── dialogs ──
  function details(it) {
    var kv = el('dl', { class: 'md-kv' });
    function row(k, v) { if (v) { kv.appendChild(el('dt', { text: T(k) })); kv.appendChild(el('dd', { text: v })); } }
    row('cv.d_source', it.source);
    row('cv.d_path', it.path);
    row('cv.d_video', it.video);
    row('cv.d_runtime', it.runtime ? time(Math.round(it.runtime / 60)) : null);
    row('cv.d_size', size(it.size));
    var e = it.estimate;
    row('cv.d_estimate', !e ? T('cv.d_estimate_none') : (e.kind === 'remux' ? T('cv.d_estimate_remux') : T('cv.d_estimate_v', { size: size(e.size), time: time(minutesOf(it)) })));
    if (it.stalled) row('cv.d_stalled', T('cv.d_stalled_v', { when: P.when(it.stalled.at), reasons: (it.stalled.reasons || []).join(', ') || '–' }));
    if (conv(it).requested) row('cv.d_requested', P.when(conv(it).requested));
    var why = el('ul', { class: 'md-cv-why' }, (it.reasons || []).map(function (r) {
      return el('li', null, [el('span', null, [pill(r.label, LEVEL_TONE[r.level]), ' ', devices(r.devices)]), el('span', { text: T('cv.why.' + r.code) })]);
    }));
    return el('div', { class: 'md-cv-dlg' }, [el('h3', { text: title(it) }), devices(it.devices), kv, el('div', { class: 'form-label', text: T('cv.d_reasons') }), why,
      el('p', { class: 'md-hint', text: data && data.available ? T('cv.d_note_on') : T('cv.d_note') })]);
  }

  function streams(p) {
    if (!p) return '–';
    return [p.codec ? String(p.codec).toUpperCase().replace('H264', 'H.264') : null, p.profile, p.bits ? p.bits + ' Bit' : null,
      p.height ? p.height + 'p' + (p.fps ? Math.round(p.fps) : '') : null].filter(Boolean).join(' · ');
  }
  function checkDialog(it) {
    return api('GET', 'admin/convert/file?sourceId=' + encodeURIComponent(it.sourceId) + '&id=' + encodeURIComponent(it.id)).then(function (r) {
      var job = r.job;
      var res = (job && job.result) || {};
      var src = res.source || null, out = res.output || null;
      var chk = r.file.check || {};
      var rows = [];
      function line(k, a, b, ok) { rows.push(el('tr', null, [el('th', { scope: 'row', text: T(k) }), el('td', { text: a }), el('td', { text: b }), el('td', { class: 'md-cv-ok' }, [ok ? icon('check') : null])])); }
      var same = function (k) { return src && out && src[k] === out[k]; };
      if (src || out) {
        line('cv.k_video', streams(src), streams(out), out && out.bits === 8);
        line('cv.k_duration', clock(src && src.duration), clock(out && out.duration), src && out && Math.abs(src.duration - out.duration) <= 0.6);
        line('cv.k_audio', src ? String(src.audio) : '–', out ? T('cv.k_same', { n: out.audio }) : '–', same('audio'));
        line('cv.k_subs', src ? String(src.subtitles) : '–', out ? T('cv.k_same', { n: out.subtitles }) : '–', same('subtitles'));
        line('cv.k_chapters', src ? (src.chapters || 0) + ' / ' + (src.attachments || 0) : '–', out ? (out.chapters || 0) + ' / ' + (out.attachments || 0) : '–', same('chapters') && same('attachments'));
        line('cv.k_size', size(src && src.size), size(out && out.size), false);
        line('cv.k_probe', '–', T('cv.k_probe_v', { mode: T('cv.mode.' + (res.mode || 'vaapi_icq')) }), true);
      }
      line('cv.k_jellyfin', '–', chk.ok === true ? T('cv.k_jf_ok') : (chk.ok === false ? T('cv.k_jf_no') : T('cv.k_jf_wait')), chk.ok === true);
      var head = el('div', { class: 'md-cv-chk-head' }, [el('h3', { text: title(r.file.item) }),
        job ? el('p', { class: 'md-sub', text: T('cv.chk_sub', { day: date(job.finishedAt), from: hm(job.startedAt), to: hm(job.finishedAt),
          min: job.startedAt && job.finishedAt ? Math.max(1, Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 60000)) : '–' }) }) : null]);
      var banner = r.file.state === 'done' && chk.ok !== false
        ? el('p', { class: 'md-ok' }, [icon('check'), el('span', { text: T('cv.chk_ok') })])
        : (r.file.state === 'restored' ? el('p', { class: 'md-note', text: T('cv.chk_restored') }) : (r.file.state === 'checking' ? el('p', { class: 'md-info', text: T('cv.chk_wait') }) : null));
      var attempts = (r.attempts || []).filter(function (a) { return a.state === 'failed'; });
      var parts = [head, banner];
      if (rows.length) parts.push(el('div', { class: 'md-table-wrap' }, [el('table', { class: 'md-table md-cv-chk' }, [
        el('thead', null, [el('tr', null, [el('th', { scope: 'col', text: T('cv.k_check') }), el('th', { scope: 'col', text: T('cv.k_orig') }), el('th', { scope: 'col', text: T('cv.k_new') }), el('th', null)])]),
        el('tbody', null, rows)])]));
      attempts.forEach(function (a) {
        parts.push(el('div', { class: 'md-note' }, [el('b', { text: T('cv.attempt', { when: P.when(a.finishedAt), error: errText(a.error) }) }),
          a.log && a.log.length ? el('pre', { class: 'md-mono md-cv-log', text: a.log.join('\n') }) : null]));
      });
      if (r.trash) parts.push(el('p', { class: 'md-hint' }, [T('cv.chk_trash') + ' ', el('span', { class: 'md-mono', text: r.trash.path }), ' · ' + T('cv.chk_until', { day: date(r.trash.expiresAt) })]));
      var buttons = [{ label: T('common.close'), value: false, primary: true }];
      if (r.trash && job) {
        buttons.unshift({ label: T('cv.restore'), run: function () { return restore(job.gatewayId, job.id); } });
        buttons.unshift({ label: T('cv.purge_one'), danger: true, run: function () { return purgeOne(job.gatewayId, job.id); } });
      }
      return P.dialog(el('div', { class: 'md-cv-dlg md-cv-chkdlg' }, parts), buttons);
    }).catch(P.warn);
  }
  function restore(gatewayId, id) {
    return P.confirmDialog(T('cv.restore_q')).then(function (ok) {
      if (!ok) return false;
      return act(api('POST', 'admin/convert/trash', { gatewayId: gatewayId, id: id, action: 'restore' }), T('cv.toast_restored'));
    });
  }
  function purgeOne(gatewayId, id) {
    return P.confirmDialog(T('cv.purge_q'), T('cv.purge_one'), true).then(function (ok) {
      if (!ok) return false;
      return act(api('POST', 'admin/convert/trash', { gatewayId: gatewayId, id: id, action: 'purge' }), T('cv.toast_purged'));
    });
  }
  function trashDialog() {
    return api('GET', 'admin/convert/trash').then(function (r) {
      var box = el('div', { class: 'md-cv-dlg' }, [el('h3', { text: T('cv.trash_title') }), el('p', { class: 'md-hint', text: T('cv.trash_intro') })]);
      var any = false;
      r.gateways.forEach(function (g) {
        if (r.gateways.length > 1) box.appendChild(el('div', { class: 'form-label', text: g.name }));
        if (!g.trash.length) { box.appendChild(el('p', { class: 'md-hint', text: T('cv.trash_empty') })); return; }
        any = true;
        box.appendChild(el('div', { class: 'md-list' }, g.trash.map(function (x) {
          var d = daysUntil(x.expiresAt);
          return el('div', { class: 'md-item' }, [
            el('div', { class: 'md-item-main' }, [el('div', { class: 'md-item-title', text: x.title ? title(x.title) : (x.path || x.id) }),
              el('div', { class: 'md-item-sub md-mono', text: x.path || '' }),
              el('div', { class: 'md-item-sub', text: size(x.size) + ' · ' + T('cv.trash_until', { day: date(x.expiresAt), n: d == null ? '–' : d }) })]),
            el('div', { class: 'md-actions' }, [
              el('button', { type: 'button', class: 'btn btn-sm', on: { click: function () { restore(g.id, x.id).then(function (v) { if (v !== false) closeAll(); }); } } }, [icon('undo'), T('cv.restore_short')]),
              el('button', { type: 'button', class: 'btn btn-sm btn-danger', on: { click: function () { purgeOne(g.id, x.id).then(function (v) { if (v !== false) closeAll(); }); } } }, [icon('trash'), T('cv.purge_short')])]),
          ]);
        })));
      });
      box.appendChild(el('p', { class: 'md-hint', text: T('cv.trash_btrfs') }));
      var buttons = [{ label: T('common.close'), value: false, primary: true }];
      if (any) {
        buttons.unshift({ label: T('cv.trash_empty_btn'), danger: true, run: function () {
          return P.confirmDialog(T('cv.trash_empty_q'), T('cv.trash_empty_btn'), true).then(function (ok) {
            if (!ok) return false;
            return Promise.all(r.gateways.filter(function (g) { return g.trash.length; }).map(function (g) {
              return api('POST', 'admin/convert/trash', { gatewayId: g.id, all: true, action: 'purge' });
            })).then(function () { P.toast(T('cv.toast_emptied')); load(); return true; });
          });
        } });
      }
      return P.dialog(box, buttons);
    }).catch(P.warn);
  }
  function closeAll() { var ov = document.querySelectorAll('.modal-overlay'); for (var i = 0; i < ov.length; i++) ov[i].remove(); }
  function settingsDialog() {
    var s = data.settings;
    function hours(v) {
      var sel = el('select', { class: 'form-select' });
      for (var h = 0; h < 24; h++) sel.appendChild(el('option', { value: String(h), text: pad(h) + ':00', selected: h === v }));
      return sel;
    }
    var from = hours(s.from), to = hours(s.to);
    var pw = P.check(T('cv.set_pause'), s.pauseWatch);
    var days = P.input({ type: 'number', min: '1', max: '365', value: String(s.trashDays) });
    var q = P.input({ type: 'number', min: '16', max: '32', value: String(s.quality) });
    var box = el('div', { class: 'md-cv-dlg' }, [el('h3', { text: T('cv.settings') }),
      el('div', { class: 'form-row' }, [P.field(T('cv.set_from'), from), P.field(T('cv.set_to'), to)]),
      el('p', { class: 'md-hint', text: T('cv.set_window_hint') }),
      pw.node,
      el('div', { class: 'form-row' }, [P.field(T('cv.set_days'), days, T('cv.set_days_hint')), P.field(T('cv.set_quality'), q, T('cv.set_quality_hint'))])]);
    return P.dialog(box, [{ label: T('common.cancel'), value: false }, { label: T('common.save'), primary: true, run: function () {
      return api('PUT', 'admin/convert/settings', { from: Number(from.value), to: Number(to.value), pauseWatch: pw.box.checked, trashDays: Number(days.value), quality: Number(q.value) })
        .then(function () { P.toast(T('common.saved')); load(); return true; });
    } }]);
  }

  // ── list ──
  var FILTERS = {
    all: function (it) { return !conv(it).hidden; },
    open: function (it) { var c = conv(it); return !c.hidden && it.level === 'convert' && (c.state === 'none' || c.state === 'restored'); },
    hint: function (it) { return !conv(it).hidden && (it.level === 'hint' || it.level === 'info') && conv(it).state === 'none'; },
    queue: function (it) { return ['queued', 'running'].indexOf(conv(it).state) >= 0; },
    done: function (it) { return ['checking', 'done'].indexOf(conv(it).state) >= 0; },
    failed: function (it) { return conv(it).state === 'skipped' || (conv(it).state === 'queued' && !!conv(it).error && conv(it).error !== 'no_space'); },
    stalled: function (it) { return !conv(it).hidden && !!it.stalled; },
    requested: function (it) { return !!conv(it).requested && conv(it).state === 'none'; },
    hidden: function (it) { return !!conv(it).hidden; },
    convert: function (it) { return it.level === 'convert'; },
    info: function (it) { return it.level === 'info'; },
  };
  function matches(it) {
    if (!(FILTERS[ui.filter] || FILTERS.all)(it)) return false;
    if (!ui.q) return true;
    return (title(it) + ' ' + (it.path || '')).toLowerCase().indexOf(ui.q.toLowerCase()) >= 0;
  }
  function sorter(a, b) {
    if (ui.sort === 'title') return title(a).localeCompare(title(b), LOCALE);
    if (ui.sort === 'size') return (b.size || 0) - (a.size || 0);
    if (ui.sort === 'minutes') return (minutesOf(b) || 0) - (minutesOf(a) || 0);
    var pa = conv(a).position, pb = conv(b).position;
    if (ui.filter === 'queue' && pa && pb) return pa - pb;
    return (LEVEL_RANK[a.level] - LEVEL_RANK[b.level]) || ((b.stalled ? 1 : 0) - (a.stalled ? 1 : 0)) || ((b.size || 0) - (a.size || 0));
  }

  function drawFilters() {
    var box = P.clear($('#md-c-filters'));
    var list = data.available
      ? ['all', 'open', 'hint', 'queue', 'done', 'failed', 'stalled', 'requested', 'hidden']
      : ['all', 'convert', 'hint', 'info', 'stalled'];
    list.forEach(function (f) {
      var n = data.items.filter(f === 'hint' && !data.available ? function (it) { return it.level === 'hint'; } : FILTERS[f]).length;
      if (['stalled', 'requested', 'hidden'].indexOf(f) >= 0 && !n) return;
      box.appendChild(el('button', { type: 'button', class: 'md-chip', 'aria-pressed': ui.filter === f ? 'true' : 'false', 'data-filter': f,
        on: { click: function () { ui.filter = f; ui.shown = STEP; drawFilters(); drawList(); } } }, [T('cv.filter_' + f), el('small', { text: String(n) })]));
    });
  }

  function rowActions(it) {
    var c = conv(it);
    var cell = el('div', { class: 'md-cv-act' });
    var add = function (n) { if (n) cell.appendChild(n); };
    var moreBtn = function (items) {
      var b = el('button', { type: 'button', class: 'btn btn-sm md-cv-more', title: T('cv.more_actions'), 'aria-label': T('cv.more_actions') }, [icon('more')]);
      b.addEventListener('click', function (ev) { ev.stopPropagation(); menu(b, items); });
      return el('span', { class: 'md-menu-wrap' }, [b]);
    };
    if (c.state === 'queued') {
      var label = c.error === 'no_space' ? T('cv.st_nospace') : (c.error ? T('cv.st_retry', { error: errText(c.error) }) : (c.now ? T('cv.st_now', { n: c.position || '–' }) : T('cv.st_night', { n: c.position || '–' })));
      add(el('span', { class: 'md-cv-st', 'data-tone': c.error ? 'warn' : null }, [icon('moon'), label]));
      add(el('button', { type: 'button', class: 'btn btn-sm md-cv-x', title: T('cv.unqueue'), 'aria-label': T('cv.unqueue'), on: { click: function () { fileAct(it, 'unqueue', T('cv.toast_unqueued')); } } }, [icon('x')]));
      return cell;
    }
    if (c.state === 'running') {
      add(el('span', { class: 'md-cv-st', 'data-tone': 'good', text: c.job && c.job.percent != null ? T('cv.st_running_p', { p: Math.round(c.job.percent) }) : T('cv.st_running') }));
      return cell;
    }
    if (c.state === 'checking') { add(el('span', { class: 'md-cv-st', text: T('cv.st_checking') })); return cell; }
    if (c.state === 'done') {
      add(el('button', { type: 'button', class: 'btn btn-sm md-cv-ok-btn', on: { click: function () { checkDialog(it); } } }, [icon('check'), T(c.check && c.check.ok === false ? 'cv.st_done_unchecked' : 'cv.st_done')]));
      return cell;
    }
    if (c.state === 'skipped') {
      add(el('span', { class: 'md-cv-st', 'data-tone': 'crit', text: T('cv.st_failed', { error: errText(c.error) }) }));
      add(el('button', { type: 'button', class: 'btn btn-sm', text: T('cv.retry'), on: { click: function () { queue([it]); } } }));
      return cell;
    }
    if (c.state === 'restored') add(el('span', { class: 'md-cv-st', text: T('cv.st_restored') }));
    if (c.hidden) { add(el('button', { type: 'button', class: 'btn btn-sm', text: T('cv.unhide'), on: { click: function () { fileAct(it, 'unhide'); } } })); return cell; }
    if (c.why) {
      if (it.level === 'info') add(el('span', { class: 'md-cv-st', text: T('cv.st_live_audio') }));
      else add(el('span', { class: 'md-cv-st', text: T('cv.why.q.' + c.why) }));
      add(el('button', { type: 'button', class: 'btn btn-sm btn-link', text: T('cv.hide'), on: { click: function () { fileAct(it, 'hide', T('cv.toast_hidden')); } } }));
      return cell;
    }
    if (it.level === 'convert') {
      add(el('button', { type: 'button', class: 'btn btn-sm btn-primary md-cv-go', on: { click: function () { queue([it]); } } }, [icon('moon'), T('cv.queue')]));
    } else {
      add(el('span', { class: 'md-cv-st', text: T('cv.st_live') }));
    }
    add(moreBtn([
      it.level === 'convert' ? null : { label: T('cv.queue_night'), run: function () { queue([it]); } },
      { label: T('cv.queue_now'), run: function () { queue([it], true); } },
      { label: T('cv.hide'), run: function () { fileAct(it, 'hide', T('cv.toast_hidden')); } },
    ].filter(Boolean)));
    return cell;
  }

  function selectable(it) { var c = conv(it); return data.available && !c.why && !c.hidden && ['none', 'restored', 'skipped'].indexOf(c.state) >= 0; }

  function drawList() {
    var tbl = P.clear($('#md-c-table'));
    var list = data.items.filter(matches).sort(sorter);
    var empty = $('#md-c-empty');
    var total = data.items.length;
    empty.hidden = list.length > 0;
    empty.textContent = total ? T('cv.empty_filter') : (data.scan.at ? T('cv.empty') : (data.scan.running ? '' : T('cv.empty_scan')));
    if (!list.length && !total && data.scan.running) empty.hidden = true;
    var on = data.available;
    if (list.length) {
      tbl.appendChild(el('thead', null, [el('tr', null, [
        on ? el('th', { scope: 'col', class: 'md-cv-sel', 'aria-label': T('cv.select') }) : null,
        el('th', { scope: 'col', text: T('cv.col_title') }), el('th', { scope: 'col', text: T('cv.col_reason') }), el('th', { scope: 'col', text: T('cv.col_devices') }),
        el('th', { scope: 'col', class: 'md-num', text: T('cv.col_size') }), el('th', { scope: 'col', class: 'md-num', text: T('cv.col_minutes') }),
        on ? el('th', { scope: 'col', class: 'md-cv-acth', 'aria-label': T('cv.col_action') }) : null])]));
      var body = el('tbody');
      list.slice(0, ui.shown).forEach(function (it) {
        var c = conv(it);
        var k = it.sourceId + '/' + it.id;
        var box = null;
        if (on) {
          box = el('input', { type: 'checkbox', 'aria-label': T('cv.select_one', { title: title(it) }), checked: !!ui.sel[k], disabled: !selectable(it) });
          box.addEventListener('change', function () { if (box.checked) ui.sel[k] = it; else delete ui.sel[k]; drawSel(); });
        }
        var done = c.state === 'done' || c.state === 'checking';
        body.appendChild(el('tr', { 'data-item': it.id, 'data-level': it.level, 'data-state': c.state }, [
          on ? el('td', { class: 'md-cv-sel' }, [box]) : null,
          el('td', null, [
            el('button', { type: 'button', class: 'md-cv-title', text: title(it), title: T('cv.details'), on: { click: function () { if (done) checkDialog(it); else P.dialog(details(it)); } } }),
            it.stalled || c.requested ? el('div', { class: 'md-cv-tags' }, [it.stalled ? pill(T('cv.stalled'), 'warn') : null, c.requested && c.state === 'none' ? pill(T('cv.requested'), 'accent') : null]) : null,
            el('div', { class: 'md-cv-path', text: it.path || '', title: it.path || '' })]),
          el('td', { 'data-label': T('cv.col_reason') }, [el('div', { class: 'md-cv-reasons' }, (it.reasons || []).map(function (r) { return pill(r.label, LEVEL_TONE[r.level]); }))]),
          el('td', { 'data-label': T('cv.col_devices') }, [done ? devices({ phone: 'yes', tv: 'yes', windows: 'yes' }) : devices(it.devices)]),
          el('td', { class: 'md-num', 'data-label': T('cv.col_size'), text: sizeText(it) }),
          el('td', { class: 'md-num', 'data-label': T('cv.col_minutes'), text: minutesText(it) }),
          on ? el('td', { class: 'md-cv-actc' }, [rowActions(it)]) : null,
        ]));
      });
      tbl.appendChild(body);
    }
    var more = P.clear($('#md-c-more'));
    if (list.length > ui.shown) {
      more.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('cv.more', { n: Math.min(STEP, list.length - ui.shown) }),
        on: { click: function () { ui.shown += STEP; drawList(); } } }));
    }
    drawSel();
  }

  function drawSel() {
    var foot = [];
    var sel = Object.keys(ui.sel).map(function (k) { return ui.sel[k]; });
    var box = P.clear($('#md-c-sel'));
    if (sel.length) {
      var m = 0, s = 0;
      sel.forEach(function (it) { m += minutesOf(it) || 0; s += (it.estimate && it.estimate.size) || 0; });
      foot.push(T('cv.sel_foot', { n: sel.length, time: time(m), size: size(s), window: time(data.window.minutes) }));
      box.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('cv.sel_clear'), on: { click: function () { ui.sel = {}; drawList(); } } }));
      box.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('cv.queue_now'), on: { click: function () { queue(sel, true); } } }));
      box.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-primary', on: { click: function () { queue(sel); } } }, [icon('moon'), T('cv.sel_queue', { n: sel.length })]));
    } else {
      var tt = data.totals;
      if (data.counts.convert && !data.available) foot.push(T('cv.foot', { n: data.counts.convert, time: time(tt.minutes), size: size(tt.sizeAfter), from: data.window.from, to: data.window.to, window: time(data.window.minutes) }));
      if (data.available && data.queue.count) foot.push(T('cv.foot_queue', { n: data.queue.count, time: time(data.queue.minutes), window: time(data.window.minutes) }));
      if (data.truncated) foot.push(T('cv.truncated', { n: data.items.length }));
    }
    $('#md-c-foot').textContent = foot.join(' ');
  }

  function stat(label, value, sub, tone, onClick) {
    var kids = [el('span', { class: 'md-stat-l', text: label }), el('b', { text: value, 'data-tone': tone || null }), sub ? el('span', { class: 'md-sub', text: sub }) : null];
    if (onClick) return el('button', { type: 'button', class: 'md-stat md-stat-btn', on: { click: onClick } }, kids);
    return el('div', { class: 'md-stat' }, kids);
  }

  function serviceText(r) {
    var tc = r.transcode || {};
    if (tc.reason === 'server') return T('cv.svc.server');
    var g = (tc.gateways || [])[0];
    if (!g || tc.reason === 'gateway') return T('cv.svc.gateway');
    var p = tc.reason;
    var known = ['gateway_update', 'feature_disabled', 'offline', 'service_missing', 'service_absent', 'no_roots', 'no_device', 'device_denied', 'no_encoder', 'off'];
    return T('cv.svc.' + (known.indexOf(p) >= 0 ? p : 'other'), { gateway: g.name, gid: g.deviceGid == null ? '–' : g.deviceGid, code: p || '', min: g.minGateway || '1.50.0' });
  }

  function drawCurrent(r) {
    var box = P.clear($('#md-c-current'));
    var cur = r.current || [];
    box.hidden = !r.available || !cur.length;
    cur.forEach(function (j) {
      var enc = j.gateway && j.gateway.encoders && j.gateway.encoders.length && !j.software ? T('cv.now_hw') : T('cv.now_sw');
      var bits = [j.percent != null ? Math.round(j.percent) + ' %' : null, j.fps != null ? Math.round(j.fps) + ' B/s' : null,
        j.speed != null ? T('cv.now_speed', { x: j.speed.toLocaleString(LOCALE, { maximumFractionDigits: 2 }) }) : null,
        j.remaining != null ? T('cv.now_left', { time: time(j.remaining) }) : null,
        j.free ? T('cv.now_free', { path: j.free.path, size: size(j.free.bytes) }) : null].filter(Boolean);
      var paused = j.paused || j.state === 'paused';
      var bar = el('div', { class: 'md-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(j.percent || 0)) }, [el('span')]);
      bar.firstChild.style.width = Math.max(0, Math.min(100, j.percent || 0)) + '%';
      var it = { sourceId: j.sourceId, id: j.id };
      box.appendChild(el('div', { class: 'md-cv-cur' }, [
        el('div', { class: 'md-card-head' }, [el('h2', { class: 'md-card-title', text: T('cv.now_title') }),
          j.gateway ? el('span', { class: 'md-pill', 'data-tone': 'accent', text: T('cv.now_gw', { name: j.gateway.name, how: enc }) }) : null]),
        el('div', { class: 'md-cv-cur-t', text: j.item && j.item.name ? title(j.item) : j.id }),
        el('div', { class: 'md-cv-cur-row' }, [bar,
          el('div', { class: 'md-actions md-cv-cur-btns' }, [
            el('button', { type: 'button', class: 'btn btn-sm', on: { click: function () { fileAct(it, paused ? 'resume' : 'pause'); } } }, [icon(paused ? 'play' : 'pause'), T(paused ? 'cv.resume' : 'cv.pause')]),
            el('button', { type: 'button', class: 'btn btn-sm btn-danger', on: { click: function () {
              P.confirmDialog(T('cv.cancel_q'), T('cv.cancel'), true).then(function (ok) { if (ok) fileAct(it, 'unqueue', T('cv.toast_cancelled')); });
            } } }, [icon('x'), T('cv.cancel')])])]),
        el('p', { class: 'md-sub' }, [bits.join(' · ')]),
        j.pausedAll ? el('p', { class: 'md-hint', text: T('cv.now_watching') }) : null,
        j.state === 'verifying' ? el('p', { class: 'md-hint', text: T('cv.now_verifying') }) : null,
      ]));
    });
  }

  function draw(r) {
    data = r;
    var c = r.counts;
    var on = r.available;
    $('#md-c-intro').textContent = on ? T('cv.intro_on', { days: r.settings.trashDays }) : T('cv.intro');
    var svc = $('#md-c-service');
    svc.hidden = on;
    if (!on) svc.textContent = serviceText(r);
    var probs = P.clear($('#md-c-problems'));
    if (!r.scan.sources.length) probs.appendChild(el('p', { class: 'md-note', text: T('cv.no_source') }));
    r.scan.sources.forEach(function (s) {
      if (s.error) probs.appendChild(el('p', { class: 'md-note', text: T('cv.source_error', { source: s.name, error: T('error.' + s.error) }) }));
    });
    if (on) (r.transcode.gateways || []).forEach(function (g) {
      if (g.problem && r.transcode.gateways.length > 1) probs.appendChild(el('p', { class: 'md-note', text: serviceText({ transcode: { reason: g.problem, gateways: [g] } }) }));
    });
    var st = P.clear($('#md-c-stats'));
    if (on) {
      st.appendChild(stat(T('cv.stat_flagged'), String(c.convert + c.hint), T('cv.stat_flagged_sub', { convert: c.convert, hint: c.hint }), c.convert ? 'warn' : null));
      st.appendChild(stat(T('cv.stat_queue'), String(r.queue.count), r.queue.count ? T(r.queue.fits ? 'cv.stat_queue_fits' : 'cv.stat_queue_more', { time: time(r.queue.minutes) }) : T('cv.stat_queue_empty')));
      st.appendChild(stat(T('cv.stat_window'), r.window.from + '–' + r.window.to, r.settings.pauseWatch ? T('cv.stat_window_sub') : T('cv.stat_window_sub_off')));
      var d = r.trash.oldest ? daysUntil(r.trash.oldest) : null;
      st.appendChild(stat(T('cv.stat_trash'), r.trash.count ? r.trash.count + ' · ' + size(r.trash.bytes) : '0',
        r.trash.count ? (d == null ? T('cv.stat_trash_sub0', { days: r.settings.trashDays }) : T('cv.stat_trash_sub', { n: d })) : T('cv.stat_trash_none', { days: r.settings.trashDays }), null, trashDialog));
    } else {
      st.appendChild(stat(T('cv.stat_flagged'), String(c.convert + c.hint), T('cv.stat_flagged_sub', { convert: c.convert, hint: c.hint }), c.convert ? 'warn' : null));
      st.appendChild(stat(T('cv.stat_info'), String(c.info), T('cv.stat_info_sub')));
      st.appendChild(stat(T('cv.stat_est'), c.convert ? '≈ ' + time(r.totals.minutes) : '–',
        c.convert ? T('cv.stat_est_sub', { before: size(r.totals.sizeBefore), after: size(r.totals.sizeAfter), from: r.window.from, to: r.window.to, window: time(r.window.minutes) }) : null));
      st.appendChild(stat(T('cv.stat_scan'), r.scan.at ? P.when(r.scan.at) : T('cv.never'), r.scan.at ? T('cv.stat_scan_sub', { n: r.scan.total.toLocaleString(LOCALE) }) : null));
    }
    drawCurrent(r);
    $('#md-c-running').hidden = !r.scan.running;
    $('#md-c-scan').disabled = !!r.scan.running || !r.scan.sources.length;
    $('#md-c-settings').hidden = !on;
    var open = r.items.filter(function (it) { var x = conv(it); return it.level === 'convert' && x.state === 'none' && !x.hidden && !x.why; }).length;
    var all = $('#md-c-all');
    all.hidden = !on;
    P.clear(all);
    all.appendChild(icon('moon'));
    all.appendChild(document.createTextNode(T('cv.all', { n: open })));
    all.disabled = !open;
    Object.keys(ui.sel).forEach(function (k) { var it = r.items.filter(function (x) { return x.sourceId + '/' + x.id === k; })[0]; if (it && selectable(it)) ui.sel[k] = it; else delete ui.sel[k]; });
    drawFilters();
    drawList();
    clearTimeout(timer);
    if (r.scan.running) timer = setTimeout(load, 3000);
    else if (on && (r.current.length || r.items.some(function (it) { return conv(it).state === 'checking'; }))) timer = setTimeout(load, 15000);
  }

  function load() {
    return P.api('GET', 'admin/convert').then(draw).catch(P.warn);
  }

  var sort = $('#md-c-sort');
  ['level', 'size', 'minutes', 'title'].forEach(function (k) { sort.appendChild(el('option', { value: k, text: T('cv.sort_' + k) })); });
  sort.addEventListener('change', function () { ui.sort = sort.value; ui.shown = STEP; if (data) drawList(); });
  $('#md-c-q').addEventListener('input', function (ev) { ui.q = ev.target.value.trim(); ui.shown = STEP; if (data) drawList(); });
  $('#md-c-scan').addEventListener('click', function () {
    $('#md-c-scan').disabled = true;
    P.api('POST', 'admin/convert/scan', {}).then(function () { P.toast(T('cv.scan_started')); return load(); }).catch(function (e) { $('#md-c-scan').disabled = false; P.warn(e); });
  });
  var gearBtn = $('#md-c-settings');
  gearBtn.insertBefore(icon('gear'), gearBtn.firstChild);
  gearBtn.addEventListener('click', function () { if (data) settingsDialog(); });
  $('#md-c-all').addEventListener('click', function () {
    var b = $('#md-c-all');
    b.disabled = true;
    act(api('POST', 'admin/convert/all', {}), T('cv.toast_queued'));
  });
  load();
})();
