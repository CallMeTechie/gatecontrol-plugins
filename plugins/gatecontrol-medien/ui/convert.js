/* Page "Umwandeln" (1.5.0, step 1): the list of videos that do not play everywhere — reason, devices, size, estimated
   duration; filter, search, sort, details. Converting itself needs the gateway service and comes later: the page has
   no button that would pretend otherwise. */
(function () {
  'use strict';
  var P = window.MD;
  var T = P.T, el = P.el, $ = P.$;
  var SVG = 'http://www.w3.org/2000/svg';
  var ICONS = {
    phone: ['M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M11 18h2'],
    tv: ['M3 6h18v11H3z', 'M8 21h8', 'M12 17v4'],
    windows: ['M3 4h18v12H3z', 'M9 20h6', 'M12 16v4'],
  };
  var MARK = { yes: '✓', maybe: '~', no: '✕' };
  var LEVEL_TONE = { convert: 'crit', hint: 'warn', info: null };
  var LEVEL_RANK = { convert: 0, hint: 1, info: 2 };
  var STEP = 100;
  var ui = { filter: 'all', sort: 'level', q: '', shown: STEP };
  var data = null;
  var timer = null;
  var LOCALE = P.CTX.lang === 'en' ? 'en-GB' : 'de-DE';

  function icon(kind) {
    var s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    ICONS[kind].forEach(function (d) { var p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d); s.appendChild(p); });
    return s;
  }
  function size(b) {
    if (b == null) return '–';
    if (b >= 1e9) return (b / 1e9).toLocaleString(LOCALE, { maximumFractionDigits: 1 }) + ' GB';
    return Math.max(1, Math.round(b / 1e6)).toLocaleString(LOCALE) + ' MB';
  }
  function time(min) {
    if (min == null) return '–';
    var h = Math.floor(min / 60);
    return h ? T('cv.time_h', { h: h, m: min % 60 }) : T('cv.time_m', { m: min });
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
  function sizeText(it) {
    var e = it.estimate;
    if (e && e.kind === 'encode' && e.size != null) return size(it.size) + ' → ≈ ' + size(e.size);
    return size(it.size);
  }
  function minutesText(it) {
    var e = it.estimate;
    if (!e) return '–';
    if (e.kind === 'remux') return T('cv.remux');
    return e.minutes == null ? '–' : '≈ ' + time(e.minutes);
  }

  function details(it) {
    var kv = el('dl', { class: 'md-kv' });
    function row(k, v) { if (v) { kv.appendChild(el('dt', { text: T(k) })); kv.appendChild(el('dd', { text: v })); } }
    row('cv.d_source', it.source);
    row('cv.d_path', it.path);
    row('cv.d_video', it.video);
    row('cv.d_runtime', it.runtime ? time(Math.round(it.runtime / 60)) : null);
    row('cv.d_size', size(it.size));
    var e = it.estimate;
    row('cv.d_estimate', !e ? T('cv.d_estimate_none') : (e.kind === 'remux' ? T('cv.d_estimate_remux') : T('cv.d_estimate_v', { size: size(e.size), time: time(e.minutes) })));
    if (it.stalled) row('cv.d_stalled', T('cv.d_stalled_v', { when: P.when(it.stalled.at), reasons: (it.stalled.reasons || []).join(', ') || '–' }));
    var why = el('ul', { class: 'md-cv-why' }, it.reasons.map(function (r) {
      return el('li', null, [el('span', null, [pill(r.label, LEVEL_TONE[r.level]), ' ', devices(r.devices)]), el('span', { text: T('cv.why.' + r.code) })]);
    }));
    return el('div', { class: 'md-cv-dlg' }, [el('h3', { text: title(it) }), devices(it.devices), kv, el('div', { class: 'form-label', text: T('cv.d_reasons') }), why,
      el('p', { class: 'md-hint', text: T('cv.d_note') })]);
  }

  function matches(it) {
    if (ui.filter === 'stalled' ? !it.stalled : (ui.filter !== 'all' && it.level !== ui.filter)) return false;
    if (!ui.q) return true;
    var q = ui.q.toLowerCase();
    return (title(it) + ' ' + (it.path || '')).toLowerCase().indexOf(q) >= 0;
  }
  function sorter(a, b) {
    if (ui.sort === 'title') return title(a).localeCompare(title(b), LOCALE);
    if (ui.sort === 'size') return (b.size || 0) - (a.size || 0);
    if (ui.sort === 'minutes') return ((b.estimate && b.estimate.minutes) || 0) - ((a.estimate && a.estimate.minutes) || 0);
    return (LEVEL_RANK[a.level] - LEVEL_RANK[b.level]) || ((b.stalled ? 1 : 0) - (a.stalled ? 1 : 0)) || ((b.size || 0) - (a.size || 0));
  }

  function drawFilters() {
    var c = data.counts;
    var box = P.clear($('#md-c-filters'));
    [['all', c.convert + c.hint + c.info], ['convert', c.convert], ['hint', c.hint], ['info', c.info], ['stalled', c.stalled]].forEach(function (f) {
      if (f[0] === 'stalled' && !f[1]) return;
      box.appendChild(el('button', { type: 'button', class: 'md-chip', 'aria-pressed': ui.filter === f[0] ? 'true' : 'false', 'data-filter': f[0],
        on: { click: function () { ui.filter = f[0]; ui.shown = STEP; drawFilters(); drawList(); } } }, [T('cv.filter_' + f[0]), el('small', { text: String(f[1]) })]));
    });
  }

  function drawList() {
    var tbl = P.clear($('#md-c-table'));
    var list = data.items.filter(matches).sort(sorter);
    var empty = $('#md-c-empty');
    var total = data.counts.convert + data.counts.hint + data.counts.info;
    empty.hidden = list.length > 0;
    empty.textContent = total ? T('cv.empty_filter') : (data.scan.at ? T('cv.empty') : (data.scan.running ? '' : T('cv.empty_scan')));
    if (!list.length && !total && data.scan.running) empty.hidden = true;
    if (list.length) {
      tbl.appendChild(el('thead', null, [el('tr', null, [
        el('th', { scope: 'col', text: T('cv.col_title') }), el('th', { scope: 'col', text: T('cv.col_reason') }), el('th', { scope: 'col', text: T('cv.col_devices') }),
        el('th', { scope: 'col', class: 'md-num', text: T('cv.col_size') }), el('th', { scope: 'col', class: 'md-num', text: T('cv.col_minutes') })])]));
      var body = el('tbody');
      list.slice(0, ui.shown).forEach(function (it) {
        body.appendChild(el('tr', { 'data-item': it.id, 'data-level': it.level }, [
          el('td', null, [
            el('button', { type: 'button', class: 'md-cv-title', text: title(it), title: T('cv.details'), on: { click: function () { P.dialog(details(it)); } } }),
            it.stalled ? el('div', null, [pill(T('cv.stalled'), 'warn')]) : null,
            el('div', { class: 'md-cv-path', text: it.path || '', title: it.path || '' })]),
          el('td', { 'data-label': T('cv.col_reason') }, [el('div', { class: 'md-cv-reasons' }, it.reasons.map(function (r) { return pill(r.label, LEVEL_TONE[r.level]); }))]),
          el('td', { 'data-label': T('cv.col_devices') }, [devices(it.devices)]),
          el('td', { class: 'md-num', 'data-label': T('cv.col_size'), text: sizeText(it) }),
          el('td', { class: 'md-num', 'data-label': T('cv.col_minutes'), text: minutesText(it) }),
        ]));
      });
      tbl.appendChild(body);
    }
    var more = P.clear($('#md-c-more'));
    if (list.length > ui.shown) {
      more.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('cv.more', { n: Math.min(STEP, list.length - ui.shown) }),
        on: { click: function () { ui.shown += STEP; drawList(); } } }));
    }
    var foot = [];
    var tt = data.totals;
    if (data.counts.convert) foot.push(T('cv.foot', { n: data.counts.convert, time: time(tt.minutes), size: size(tt.sizeAfter), from: data.window.from, to: data.window.to, window: time(data.window.minutes) }));
    if (data.truncated) foot.push(T('cv.truncated', { n: data.items.length }));
    $('#md-c-foot').textContent = foot.join(' ');
  }

  function stat(label, value, sub, tone) {
    return el('div', { class: 'md-stat' }, [el('span', { class: 'md-stat-l', text: label }), el('b', { text: value, 'data-tone': tone || null }), sub ? el('span', { class: 'md-sub', text: sub }) : null]);
  }

  function draw(r) {
    data = r;
    var c = r.counts;
    var probs = P.clear($('#md-c-problems'));
    if (!r.scan.sources.length) probs.appendChild(el('p', { class: 'md-note', text: T('cv.no_source') }));
    r.scan.sources.forEach(function (s) {
      if (s.error) probs.appendChild(el('p', { class: 'md-note', text: T('cv.source_error', { source: s.name, error: T('error.' + s.error) }) }));
    });
    var st = P.clear($('#md-c-stats'));
    st.appendChild(stat(T('cv.stat_flagged'), String(c.convert + c.hint), T('cv.stat_flagged_sub', { convert: c.convert, hint: c.hint }), c.convert ? 'warn' : null));
    st.appendChild(stat(T('cv.stat_info'), String(c.info), T('cv.stat_info_sub')));
    st.appendChild(stat(T('cv.stat_est'), c.convert ? '≈ ' + time(r.totals.minutes) : '–',
      c.convert ? T('cv.stat_est_sub', { before: size(r.totals.sizeBefore), after: size(r.totals.sizeAfter), from: r.window.from, to: r.window.to, window: time(r.window.minutes) }) : null));
    st.appendChild(stat(T('cv.stat_scan'), r.scan.at ? P.when(r.scan.at) : T('cv.never'), r.scan.at ? T('cv.stat_scan_sub', { n: r.scan.total.toLocaleString(LOCALE) }) : null));
    $('#md-c-running').hidden = !r.scan.running;
    $('#md-c-scan').disabled = !!r.scan.running || !r.scan.sources.length;
    drawFilters();
    drawList();
    clearTimeout(timer);
    if (r.scan.running) timer = setTimeout(load, 3000);
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
  load();
})();
