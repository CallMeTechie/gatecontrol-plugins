/* NAS (Synology) page: NAS cards, detail view, add/edit dialog with
   connection test and one-time code, reboot / shutdown, Hyper Backup "now",
   settings. Everything goes through the plugin API (window.GC); the DSM
   password and device token never come back to the page. */
(function () {
  'use strict';
  var S = window.SY, T = S.T, $ = S.$, el = S.el;
  var ICON_NAS = 'M5 3h14v18H5zM8 7h8M8 11h8M9 16.5h.01M12 16.5h.01M15 16.5h.01';

  var data = null;        // GET /status
  var editing = null;     // NAS being edited (null = new)
  var detailId = null;    // NAS shown in the detail view
  var deviceRef = null;   // device token handle from "Verbindung testen" with a code
  var busy = false;

  function errText(e) { return (e && e.data && e.data.error) || (e && e.message) || T('common.error'); }
  function errCode(e) { return (e && e.data && e.data.code) || null; }
  function warn(e) { S.toast(errText(e), 'error'); }
  function setMsg(id, text, tone) { var m = $(id); if (m) { m.textContent = text || ''; m.setAttribute('data-tone', tone || ''); } }
  function byId(id) { return ((data && data.nas) || []).find(function (n) { return n.id === id; }) || null; }

  // ── tabs ─────────────────────────────────────────────────────────────────
  function showTab(name) {
    ['nas', 'settings'].forEach(function (n) {
      var on = n === name;
      $('#sy-tab-' + n).classList.toggle('active', on);
      $('#sy-tab-' + n).setAttribute('aria-selected', on ? 'true' : 'false');
      $('#sy-pane-' + n).hidden = !on;
    });
  }
  $('#sy-tab-nas').addEventListener('click', function () { showTab('nas'); });
  $('#sy-tab-settings').addEventListener('click', function () { showTab('settings'); });

  // ── load ─────────────────────────────────────────────────────────────────
  function load() {
    return S.api('GET', 'status').then(function (r) { data = r; render(); }).catch(warn);
  }
  function render() {
    $('#sy-no-target').hidden = (data.targets || []).length > 0;
    var s = data.settings;
    $('#sy-info').textContent = T('info.line', { interval: S.duration(s.poll_interval), polls: s.unreachable_polls });
    renderList();
    if (detailId != null) {
      if (byId(detailId)) renderDetail(byId(detailId)); else showList();
    }
    fillSettings();
  }

  // ── status of a NAS ─────────────────────────────────────────────────────
  function stateOf(n) {
    var worst = (n.issues || []).reduce(function (w, i) { return i.level === 'crit' ? 'crit' : (w === 'crit' ? w : (i.level === 'warn' ? 'warn' : w)); }, null);
    if (!n.enabled) return { tone: null, text: T('st.disabled') };
    if (n.power && n.power.state === 'shutdown' && n.status !== 'ok') return { tone: null, text: T('st.shutdown') };
    if (n.power && n.power.state === 'reboot') return { tone: 'warn', text: T('st.reboot') };
    if (n.status === 'new') return { tone: null, text: T('st.new') };
    if (n.status === 'otp') return { tone: 'error', text: T('st.otp') };
    if (n.status === 'auth') return { tone: 'error', text: T('st.auth') };
    if (n.status === 'error') return { tone: 'error', text: n.error_count >= data.settings.unreachable_polls ? T('st.unreachable') : T('st.error') };
    if (worst === 'crit') return { tone: 'error', text: T('st.crit') };
    if (worst === 'warn') return { tone: 'warn', text: T('st.warn') };
    return { tone: 'good', text: T('st.ok') };
  }
  function tag(st) { return el('span', { class: 'tag', 'data-tone': st.tone, text: st.text }); }
  function poolName(p) { return T('pool.name', { n: p.num != null ? p.num : p.id }); }
  function issueText(i) {
    switch (i.kind) {
      case 'pool': return T('issue.pool_' + i.status, { name: T('pool.name', { n: i.num != null ? i.num : i.id }) });
      case 'volume': return T('issue.volume_' + i.status, { name: i.name });
      case 'full': return T('issue.full', { name: i.name, pct: S.num(i.pct, 1) });
      case 'disk': return T('issue.disk_' + i.status, { name: i.name });
      case 'hot': return T('issue.hot', { name: i.name, temp: S.num(i.temp) });
      case 'backup': return T('issue.backup_' + i.status, { name: i.name });
      case 'ups': return T('issue.ups_' + i.status, { charge: S.num(i.charge) });
      case 'update': return T('issue.update', { version: i.version || '?' });
      default: return i.kind;
    }
  }
  function issueList(n, max) {
    var list = n.issues || [];
    if (!list.length) return null;
    var shown = list.slice(0, max || list.length);
    var box = el('ul', { class: 'sy-issues' }, shown.map(function (i) {
      return el('li', { class: 'sy-issue', 'data-level': i.level }, [el('span', { class: 'sy-dot' }), el('span', { text: issueText(i) })]);
    }));
    if (list.length > shown.length) box.appendChild(el('li', { class: 'sy-issue sy-more', text: T('issue.more', { n: list.length - shown.length }) }));
    return box;
  }
  function bar(pct, level) {
    var b = el('div', { class: 'sy-meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': pct == null ? '0' : String(Math.round(pct)) });
    var f = el('div', { class: 'sy-meter-fill', 'data-level': level || null });
    f.style.width = (pct == null ? 0 : Math.max(0, Math.min(100, pct))) + '%';
    b.appendChild(f);
    return b;
  }
  function volLevel(v) {
    if (v.status === 'crashed' || (v.pct != null && v.pct >= 98)) return 'crit';
    if (v.status === 'degraded' || (v.pct != null && v.pct >= data.settings.storage_full_pct)) return 'warn';
    return null;
  }
  function metric(label, value, level) {
    return el('div', { class: 'sy-metric', 'data-level': level || null }, [el('div', { class: 'sy-metric-v', text: value }), el('div', { class: 'sy-metric-l', text: label })]);
  }
  function metrics(d) {
    var info = d.info || {}, util = d.util || {};
    var temp = info.temp != null ? S.num(info.temp) + ' °C' : '–';
    return el('div', { class: 'sy-metrics' }, [
      metric(T('m.cpu'), util.cpu != null ? S.num(util.cpu) + ' %' : '–', util.cpu >= 90 ? 'warn' : null),
      metric(T('m.ram'), util.ram != null ? S.num(util.ram) + ' %' : '–', util.ram >= 90 ? 'warn' : null),
      metric(T('m.temp'), temp, info.temp_warn ? 'warn' : null),
      metric(T('m.uptime'), S.duration(info.uptime_s)),
    ]);
  }
  function volumeRows(d) {
    var vols = d.volumes || [];
    if (!vols.length) return el('div', { class: 'sy-empty', text: d.apis && d.apis.storage === false ? T('vol.unavailable') : T('vol.none') });
    return el('div', { class: 'sy-vols' }, vols.map(function (v) {
      var label = [v.name, v.desc].filter(Boolean).join(' · ');
      var right = v.total != null ? T('vol.used', { used: S.bytes(v.used), total: S.bytes(v.total), pct: S.num(v.pct, 1) }) : '–';
      var head = [el('span', { class: 'sy-vol-name', text: label }), el('span', { class: 'sy-vol-size', text: right })];
      if (v.status !== 'normal') head.splice(1, 0, el('span', { class: 'tag', 'data-tone': v.status === 'crashed' ? 'error' : 'warn', text: T('vstatus.' + v.status) }));
      return el('div', { class: 'sy-vol' }, [el('div', { class: 'sy-vol-head' }, head), bar(v.pct, volLevel(v))]);
    }));
  }
  function diskSummary(d) {
    var disks = d.disks || [];
    if (!disks.length) return null;
    var bad = disks.filter(function (k) { return k.health === 'warning' || k.health === 'failing'; });
    var hot = disks.filter(function (k) { return k.temp != null && k.temp >= data.settings.disk_temp_max; });
    var temps = disks.map(function (k) { return k.temp; }).filter(function (x) { return x != null; });
    var max = temps.length ? Math.max.apply(null, temps) : null;
    var text = bad.length ? T('disks.bad', { n: disks.length, bad: bad.length }) : T('disks.ok', { n: disks.length });
    if (max != null) text += ' · ' + T('disks.max_temp', { temp: S.num(max) });
    return el('div', { class: 'sy-sub' + (bad.length || hot.length ? ' is-warn' : '') }, [text]);
  }
  function meta(n) {
    var out = [];
    if (n.last_success_at) out.push(el('span', { text: T('meta.updated', { when: S.when(n.last_success_at) }) }));
    else if (n.status === 'new') out.push(el('span', { text: T('meta.never') }));
    if (n.error && n.status !== 'ok') {
      out.push(el('span', { class: 'is-error', text: T('meta.error', { when: S.when(n.last_attempt_at), error: n.error.text }) }));
      if (n.data) out.push(el('span', { text: T('meta.stale') }));
    }
    if (n.enabled && n.next_poll_at) out.push(el('span', { text: T('meta.next', { when: S.when(Math.max(n.next_poll_at, data.now || 0)) }) }));
    return el('div', { class: 'sy-meta' }, out);
  }
  function subline(n) {
    var d = n.data || {}, info = d.info || {};
    var parts = [info.model, info.dsm].filter(Boolean);
    if (!parts.length) parts.push(n.target_label || T('target.missing'));
    return parts.join(' · ');
  }

  // ── list ─────────────────────────────────────────────────────────────────
  function card(n) {
    var ic = el('div', { class: 'sy-ic' }); ic.appendChild(S.svg(ICON_NAS, 20));
    var d = n.data;
    var kids = [
      el('div', { class: 'sy-head' }, [ic, el('div', { class: 'sy-head-text' }, [el('div', { class: 'sy-name', text: n.name }), el('div', { class: 'sy-sub', text: subline(n) })]), tag(stateOf(n))]),
    ];
    if (n.target_missing) kids.push(el('div', { class: 'banner banner-warn sy-inline', text: T('target.missing_card') }));
    if (n.status === 'otp' || n.status === 'auth') kids.push(el('div', { class: 'banner banner-warn sy-inline', text: n.status === 'otp' ? T('card.otp') : T('card.auth') }));
    if (d) {
      kids.push(metrics(d));
      kids.push(el('div', null, [el('div', { class: 'sy-lbl', text: T('vol.title') }), volumeRows(d)]));
      kids.push(diskSummary(d));
      kids.push(issueList(n, 4));
    }
    kids.push(meta(n));
    kids.push(el('div', { class: 'sy-foot' }, [
      el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: T('common.details'), on: { click: function () { showDetail(n.id); } } }),
      el('button', { type: 'button', class: 'btn btn-sm', text: T('common.refresh'), disabled: n.enabled ? null : 'disabled', on: { click: function (e) { refresh(n, e.currentTarget); } } }),
      el('button', { type: 'button', class: 'btn btn-sm', text: n.status === 'otp' ? T('card.enter_code') : T('common.edit'), on: { click: function () { openNas(n); } } }),
    ]));
    return el('div', { class: 'sy-card' + (n.enabled ? '' : ' is-disabled'), 'data-id': String(n.id) }, kids);
  }
  function renderList() {
    var box = S.clear($('#sy-list'));
    if (!data.nas.length) { box.appendChild(el('div', { class: 'sy-empty', text: T('nas.empty') })); return; }
    data.nas.forEach(function (n) { box.appendChild(card(n)); });
  }
  function refresh(n, btn) {
    if (btn) btn.disabled = true;
    return S.api('POST', 'nas/' + n.id + '/refresh').then(function (r) {
      if (r.result && r.result.ok) S.toast(T('refresh.ok'));
      else S.toast(T('refresh.failed', { error: (r.result && r.result.error) || T('common.error') }), 'error');
      return load();
    }).catch(warn).then(function () { if (btn) btn.disabled = false; });
  }

  // ── detail ───────────────────────────────────────────────────────────────
  function showDetail(id) {
    detailId = id;
    $('#sy-list-view').hidden = true;
    $('#sy-detail-view').hidden = false;
    renderDetail(byId(id));
  }
  function showList() {
    detailId = null;
    $('#sy-detail-view').hidden = true;
    $('#sy-list-view').hidden = false;
  }
  $('#sy-back').addEventListener('click', showList);

  function table(cols, rows, empty) {
    if (!rows.length) return el('div', { class: 'sy-empty', text: empty });
    return el('div', { class: 'sy-table-wrap' }, [el('table', { class: 'sy-table' }, [
      el('thead', null, [el('tr', null, cols.map(function (c) { return el('th', { text: c }); }))]),
      el('tbody', null, rows.map(function (r) { return el('tr', null, r.map(function (c) { return el('td', null, [c == null ? '–' : c]); })); })),
    ])]);
  }
  function section(title, body) { return el('div', { class: 'sy-card sy-section' }, [el('div', { class: 'sy-lbl', text: title }), body]); }
  function healthTag(h) { return el('span', { class: 'tag', 'data-tone': h === 'failing' ? 'error' : (h === 'warning' ? 'warn' : (h === 'normal' ? 'good' : null)), text: T('health.' + h) }); }
  function statusTag(s) { return el('span', { class: 'tag', 'data-tone': s === 'crashed' ? 'error' : (s === 'degraded' ? 'warn' : (s === 'normal' ? 'good' : null)), text: T('vstatus.' + s) }); }
  function kv(rows) {
    return el('dl', { class: 'sy-kv' }, rows.filter(Boolean).reduce(function (a, r) { a.push(el('dt', { text: r[0] })); a.push(el('dd', null, [r[1] == null ? '–' : r[1]])); return a; }, []));
  }

  function renderDetail(n) {
    if (!n) return;
    var acts = S.clear($('#sy-detail-actions'));
    acts.appendChild(el('button', { type: 'button', class: 'btn', text: T('common.refresh'), disabled: n.enabled ? null : 'disabled', on: { click: function (e) { refresh(n, e.currentTarget); } } }));
    acts.appendChild(el('button', { type: 'button', class: 'btn', text: T('common.edit'), on: { click: function () { openNas(n); } } }));
    acts.appendChild(el('button', { type: 'button', class: 'btn btn-danger', id: 'sy-reboot', text: T('power.reboot'), disabled: n.enabled ? null : 'disabled', on: { click: function () { powerAction(n, 'reboot'); } } }));
    acts.appendChild(el('button', { type: 'button', class: 'btn btn-danger', id: 'sy-shutdown', text: T('power.shutdown'), disabled: n.enabled ? null : 'disabled', on: { click: function () { powerAction(n, 'shutdown'); } } }));

    var box = S.clear($('#sy-detail'));
    var d = n.data || {};
    var info = d.info || {}, util = d.util || {};
    var ic = el('div', { class: 'sy-ic' }); ic.appendChild(S.svg(ICON_NAS, 22));
    var up = d.update;
    var updText = !d.apis || !d.apis.upgrade ? T('upd.unavailable') : (!up ? T('upd.unknown') : (up.available ? T('upd.available', { version: up.version || '?' }) : T('upd.current')));
    var head = el('div', { class: 'sy-card' }, [
      el('div', { class: 'sy-head' }, [ic, el('div', { class: 'sy-head-text' }, [el('div', { class: 'sy-name sy-name-lg', text: n.name }), el('div', { class: 'sy-sub', text: subline(n) })]), tag(stateOf(n))]),
      n.data ? metrics(d) : null,
      kv([
        [T('d.model'), info.model],
        [T('d.dsm'), info.dsm],
        [T('d.update'), updText],
        [T('d.ram_size'), info.ram_mb != null ? S.num(info.ram_mb / 1024, 1) + ' GB' : null],
        [T('d.uptime'), S.duration(info.uptime_s)],
        [T('d.target'), n.target_label || T('target.missing')],
        [T('d.account'), n.account.user_hint ? n.account.user_hint + (n.account.has_device ? ' · ' + T('d.device_token') : '') : '–'],
        util.cpu != null ? [T('m.cpu'), S.num(util.cpu) + ' %'] : null,
      ]),
      meta(n),
    ]);
    box.appendChild(head);
    var iss = issueList(n);
    if (iss) box.appendChild(section(T('detail.issues'), iss));
    if (!n.data) { box.appendChild(el('div', { class: 'sy-empty', text: T('detail.no_data') })); return; }

    box.appendChild(section(T('vol.title'), volumeRows(d)));
    if ((d.pools || []).length) {
      box.appendChild(section(T('pool.title'), table([T('pool.col_name'), T('pool.col_raid'), T('pool.col_status'), T('pool.col_disks'), T('pool.col_size')],
        d.pools.map(function (p) { return [poolName(p) + (p.desc ? ' · ' + p.desc : ''), p.raid, statusTag(p.status), String((p.disks || []).length || '–'), p.total != null ? S.bytes(p.total) : null]; }), '')));
    }
    var tmax = data.settings.disk_temp_max;
    box.appendChild(section(T('disk.title'), table([T('disk.col_name'), T('disk.col_model'), T('disk.col_size'), T('disk.col_temp'), T('disk.col_health')],
      (d.disks || []).map(function (k) {
        var temp = k.temp != null ? el('span', { class: k.temp >= tmax ? 'is-warn' : null, text: S.num(k.temp) + ' °C' }) : null;
        var h = el('span', { class: 'sy-cell' }, [healthTag(k.health)]);
        if (k.raw_status && k.raw_status !== 'normal') h.appendChild(el('span', { class: 'sy-raw', text: k.raw_status }));
        if (k.remain_life != null) h.appendChild(el('span', { class: 'sy-raw', text: T('disk.life', { pct: S.num(k.remain_life) }) }));
        return [k.name, [k.vendor, k.model].filter(Boolean).join(' ') || null, k.size != null ? S.bytes(k.size) : null, temp, h];
      }), d.apis && d.apis.storage === false ? T('vol.unavailable') : T('disk.none'))));

    if (Array.isArray(d.backups)) {
      box.appendChild(section(T('bk.title'), table([T('bk.col_name'), T('bk.col_result'), T('bk.col_last'), T('bk.col_next'), ''],
        d.backups.map(function (b) {
          var tone = b.result === 'failed' ? 'error' : (b.result === 'partial' ? 'warn' : (b.result === 'ok' ? 'good' : null));
          var start = el('button', { type: 'button', class: 'btn btn-sm', text: T('bk.start'), disabled: b.running || !n.enabled ? 'disabled' : null, on: { click: function (e) { startBackup(n, b, e.currentTarget); } } });
          return [b.name, el('span', { class: 'tag', 'data-tone': tone, text: b.running ? T('bk.running') : T('bk.' + b.result) }), b.last_time, b.next_time, start];
        }), T('bk.none'))));
    }
    if (d.ups) {
      box.appendChild(section(T('ups.title'), kv([
        [T('ups.model'), d.ups.model],
        [T('ups.state'), T('ups.' + d.ups.state)],
        [T('ups.charge'), d.ups.charge != null ? S.num(d.ups.charge) + ' %' : null],
        [T('ups.runtime'), d.ups.runtime_s != null ? S.duration(d.ups.runtime_s) : null],
      ])));
    }
  }

  // ── control ──────────────────────────────────────────────────────────────
  function powerAction(n, action) {
    var shutdown = action === 'shutdown';
    S.confirm(T(shutdown ? 'power.shutdown_confirm' : 'power.reboot_confirm', { name: n.name }), T(shutdown ? 'power.shutdown' : 'power.reboot'), {
      title: T(shutdown ? 'power.shutdown_title' : 'power.reboot_title'),
      detail: T(shutdown ? 'power.shutdown_detail' : 'power.reboot_detail'),
      danger: true,
      ack: shutdown ? T('power.shutdown_ack') : null,
    }).then(function (yes) {
      if (!yes) return;
      return S.api('POST', 'nas/' + n.id + '/power', { action: action, confirm: true }).then(function () {
        S.toast(T(shutdown ? 'power.shutdown_sent' : 'power.reboot_sent', { name: n.name }));
        return load();
      }).catch(warn);
    });
  }
  function startBackup(n, b, btn) {
    S.confirm(T('bk.start_confirm', { name: b.name, nas: n.name }), T('bk.start'), { title: T('bk.title') }).then(function (yes) {
      if (!yes) return;
      btn.disabled = true;
      return S.api('POST', 'nas/' + n.id + '/backups/' + b.id + '/start', { confirm: true }).then(function () {
        S.toast(T('bk.started', { name: b.name }));
        return load();
      }).catch(function (e) { btn.disabled = false; warn(e); });
    });
  }

  // ── NAS dialog ──────────────────────────────────────────────────────────
  function fillTargets(current) {
    var sel = S.clear($('#sy-n-target'));
    var list = data.targets || [];
    if (!list.length) sel.appendChild(el('option', { value: '', text: T('target.none_option') }));
    list.forEach(function (tg) { sel.appendChild(el('option', { value: String(tg.index), text: tg.label, selected: current === tg.index ? 'selected' : null })); });
    if (current != null && !list.some(function (tg) { return tg.index === current; })) {
      sel.insertBefore(el('option', { value: '', text: T('target.missing'), selected: 'selected' }), sel.firstChild);
    }
  }
  function showOtp(on) { $('#sy-n-otp-box').hidden = !on; if (on) setTimeout(function () { $('#sy-n-otp').focus(); }, 30); }
  function openNas(n) {
    editing = n || null;
    deviceRef = null;
    $('#sy-n-title').textContent = n ? T('nas.edit') : T('nas.add');
    $('#sy-n-name').value = n ? n.name : '';
    fillTargets(n ? n.target_index : null);
    if (!n && (data.targets || []).length) $('#sy-n-target').value = String(data.targets[0].index);
    $('#sy-n-user').value = '';
    $('#sy-n-pass').value = '';
    $('#sy-n-otp').value = '';
    $('#sy-n-user').placeholder = n && n.account.user_hint ? n.account.user_hint : '';
    $('#sy-n-pass').placeholder = n && n.account.has_password ? '••••••••' : '';
    $('#sy-n-cred-hint').textContent = n ? T('nas.cred_keep') : '';
    $('#sy-n-enabled').checked = n ? n.enabled : true;
    $('#sy-n-delete').hidden = !n;
    setMsg('#sy-n-msg', n && n.status === 'otp' ? T('nas.otp_needed') : '');
    setMsg('#sy-n-test-msg', '');
    showOtp(!!(n && n.status === 'otp'));
    S.openModal('sy-nas-modal');
  }
  function formBody() {
    var b = { name: $('#sy-n-name').value, enabled: $('#sy-n-enabled').checked };
    var tv = $('#sy-n-target').value;
    if (tv !== '') b.target_index = Number(tv);
    else if (!editing) b.target_index = null;
    var u = $('#sy-n-user').value.trim(), p = $('#sy-n-pass').value, o = $('#sy-n-otp').value.replace(/\s+/g, '');
    if (u) b.username = u;
    if (p) b.password = p;
    if (o && !$('#sy-n-otp-box').hidden) b.otp = o;
    if (deviceRef) b.device_ref = deviceRef;
    return b;
  }
  $('#sy-n-test').addEventListener('click', function () {
    var b = formBody();
    if (editing) b.id = editing.id;
    if (b.target_index == null) b.target_index = editing ? editing.target_index : null;
    var btn = $('#sy-n-test');
    btn.disabled = true;
    setMsg('#sy-n-test-msg', T('nas.testing'));
    S.api('POST', 'nas/test', b).then(function (r) {
      if (r.device_ref) { deviceRef = r.device_ref; $('#sy-n-otp').value = ''; showOtp(false); }
      var text = T('nas.test_ok', { model: r.model || '?', dsm: r.dsm || '?' });
      if (!r.admin) text += ' ' + T('nas.test_not_admin');
      if (r.device_ref) text += ' ' + T('nas.test_device');
      setMsg('#sy-n-test-msg', text, r.admin ? 'good' : 'warn');
    }).catch(function (e) {
      var c = errCode(e);
      if (c === 'OTP_REQUIRED' || c === 'OTP_INVALID') showOtp(true);
      setMsg('#sy-n-test-msg', errText(e), 'error');
    }).then(function () { btn.disabled = false; });
  });
  $('#sy-n-save').addEventListener('click', function () {
    if (busy) return;
    busy = true;
    var b = formBody();
    var btn = $('#sy-n-save');
    btn.disabled = true;
    setMsg('#sy-n-msg', T('nas.saving'));
    var req = editing ? S.api('PUT', 'nas/' + editing.id, b) : S.api('POST', 'nas', b);
    req.then(function (r) {
      deviceRef = null;
      var id = r.nas && r.nas.id;
      return load().then(function () {
        var res = r.result;
        if (!res || res.ok) {
          S.closeModal('sy-nas-modal');
          S.toast(res ? T('nas.saved_ok') : T('nas.saved'));
          return;
        }
        // saved, but the connection did not work: stay in the dialog (now editing the saved NAS)
        editing = byId(id) || editing;
        $('#sy-n-title').textContent = T('nas.edit');
        $('#sy-n-delete').hidden = false;
        $('#sy-n-pass').value = '';
        $('#sy-n-pass').placeholder = '••••••••';
        $('#sy-n-cred-hint').textContent = T('nas.cred_keep');
        if (res.code === 'OTP_REQUIRED' || res.code === 'OTP_INVALID') { $('#sy-n-otp').value = ''; showOtp(true); }
        setMsg('#sy-n-msg', T('nas.saved_failed', { error: res.error }), 'error');
      });
    }).catch(function (e) {
      setMsg('#sy-n-msg', errText(e), 'error');
    }).then(function () { busy = false; btn.disabled = false; });
  });
  $('#sy-n-delete').addEventListener('click', function () {
    if (!editing) return;
    var n = editing;
    S.confirm(T('nas.delete_confirm', { name: n.name }), T('common.delete'), { danger: true, detail: T('nas.delete_detail') }).then(function (yes) {
      if (!yes) return;
      return S.api('DELETE', 'nas/' + n.id).then(function () {
        S.closeModal('sy-nas-modal');
        if (detailId === n.id) showList();
        S.toast(T('nas.deleted'));
        return load();
      }).catch(warn);
    });
  });
  $('#sy-add').addEventListener('click', function () { openNas(null); });
  $('#sy-reload').addEventListener('click', function () { load(); });

  // ── settings ─────────────────────────────────────────────────────────────
  var settingsDirty = false;
  ['#sy-set-interval', '#sy-set-polls', '#sy-set-full', '#sy-set-temp', '#sy-set-lang'].forEach(function (id) {
    $(id).addEventListener('input', function () { settingsDirty = true; });
  });
  function fillSettings() {
    if (settingsDirty) return;
    var s = data.settings;
    $('#sy-set-interval').value = s.poll_interval;
    $('#sy-set-polls').value = s.unreachable_polls;
    $('#sy-set-full').value = s.storage_full_pct;
    $('#sy-set-temp').value = s.disk_temp_max;
    $('#sy-set-lang').value = s.notify_lang;
  }
  $('#sy-set-save').addEventListener('click', function () {
    var body = {
      poll_interval: Number($('#sy-set-interval').value), unreachable_polls: Number($('#sy-set-polls').value),
      storage_full_pct: Number($('#sy-set-full').value), disk_temp_max: Number($('#sy-set-temp').value), notify_lang: $('#sy-set-lang').value,
    };
    S.api('PUT', 'settings', body).then(function () {
      settingsDirty = false;
      S.toast(T('settings.saved'));
      return load();
    }).catch(warn);
  });

  load();
  // keep the page current while it is open (the background polls every minute)
  setInterval(function () {
    if (document.hidden) return;
    if (!$('#sy-nas-modal').hidden || document.querySelector('.modal-overlay[data-dynamic]')) return;
    load();
  }, 60000);
}());
