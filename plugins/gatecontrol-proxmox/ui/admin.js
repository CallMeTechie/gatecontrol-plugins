/* Proxmox VE page: overview (connections → nodes), guests (table, watch,
   control), storage and backups, connections (add / edit / test). Everything
   goes through the plugin API (window.GC); the API token secret never comes
   back from it. */
(function () {
  'use strict';
  var P = window.PX, T = P.T, $ = P.$, $$ = P.$$, el = P.el;
  var ICON_SERVER = 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01';
  var REFRESH_MS = 30000;
  var TABS = ['overview', 'guests', 'storage', 'hosts'];

  var data = null;          // GET /status
  var editHost = null;      // connection being edited (null = new)
  var pending = null;       // { host, guest, action } of the action dialog
  var actionTimer = null;

  function errText(e) { return (e && e.data && e.data.error) || (e && e.message) || T('common.error'); }
  function warn(e) { P.toast(errText(e), 'error'); }
  function setMsg(id, text, tone) { var m = $(id); if (m) { m.textContent = text || ''; m.setAttribute('data-tone', tone || ''); } }
  function tag(text, tone) { return el('span', { class: 'tag', 'data-tone': tone || null, text: text }); }
  function guestStatusTone(s) { return s === 'running' ? 'good' : (s === 'stopped' ? null : 'warn'); }
  function statusText(s) { var k = 'status.' + s; var x = T(k); return x === k ? s : x; }
  function kind(type) { return T(type === 'lxc' ? 'kind.lxc' : 'kind.qemu'); }

  // ── tabs ─────────────────────────────────────────────────────────────────
  function showTab(name) {
    TABS.forEach(function (n) {
      var on = n === name;
      $('#px-tab-' + n).classList.toggle('active', on);
      $('#px-tab-' + n).setAttribute('aria-selected', on ? 'true' : 'false');
      $('#px-pane-' + n).hidden = !on;
    });
  }
  TABS.forEach(function (n) { $('#px-tab-' + n).addEventListener('click', function () { showTab(n); }); });

  // ── load ─────────────────────────────────────────────────────────────────
  function load() {
    return P.api('GET', 'status').then(function (r) { data = r; render(); }).catch(warn);
  }
  function render() {
    $('#px-no-targets').hidden = data.targets.length > 0;
    $('#px-no-hosts').hidden = data.hosts.length > 0;
    renderOverview();
    renderGuestFilters();
    renderGuests();
    renderStorage();
    renderHosts();
    renderActions();
  }

  // ── overview ─────────────────────────────────────────────────────────────
  /** "zuletzt aktualisiert 14:30" / "Fehler: … (seit 3 Versuchen)" */
  function hostState(h) {
    var parts = [];
    if (!h.enabled) return el('div', { class: 'px-sub' }, [tag(T('host.disabled'))]);
    if (h.status === 'error') {
      parts.push(tag(T('host.state_error'), 'error'));
      parts.push(el('span', { class: 'is-error', text: T('host.error_line', { error: h.error_text || h.last_error, when: P.when(h.last_attempt_at), n: h.error_count }) }));
    } else if (h.status === 'ok') parts.push(tag(T('host.state_ok'), 'good'));
    else parts.push(tag(T('host.state_new')));
    if (h.last_success_at) parts.push(el('span', { text: T('host.updated', { when: P.when(h.last_success_at) }) }));
    if (h.status === 'error' && h.snapshot) parts.push(el('span', { class: 'px-stale', text: T('host.stale') }));
    return el('div', { class: 'px-sub' }, parts);
  }
  function guestSummary(s) {
    var c = { qemu: [0, 0], lxc: [0, 0] };
    (s.guests || []).forEach(function (g) { if (g.template) return; var k = g.type === 'lxc' ? 'lxc' : 'qemu'; c[k][0]++; if (g.status === 'running') c[k][1]++; });
    return T('ov.guests', { vms: c.qemu[0], vmsRun: c.qemu[1], cts: c.lxc[0], ctsRun: c.lxc[1] });
  }
  function nodeCard(n) {
    var ic = el('div', { class: 'px-ic' }); ic.appendChild(P.svg(ICON_SERVER, 20));
    var kernel = n.kversion ? String(n.kversion).replace(/^Linux\s+/, '').split(' ')[0] : null; // "Linux 6.8.12-1-pve #1 SMP …" → "6.8.12-1-pve"
    var sub = [n.pveversion ? 'PVE ' + n.pveversion : null, kernel ? T('node.kernel', { v: kernel }) : null].filter(Boolean).join(' · ');
    var body = [];
    if (n.online) {
      body.push(P.bar(T('node.cpu'), n.cpu == null ? null : n.cpu * 100, n.maxcpu ? T('node.cpus', { n: n.maxcpu }) : ''));
      body.push(P.bar(T('node.ram'), P.pct(n.mem, n.maxmem), P.bytes(n.mem) + ' / ' + P.bytes(n.maxmem)));
      var fs = n.rootfs || (n.maxdisk ? { used: n.disk, total: n.maxdisk } : null);
      if (fs) body.push(P.bar(T('node.rootfs'), P.pct(fs.used, fs.total), P.bytes(fs.used) + ' / ' + P.bytes(fs.total)));
      if (n.swap && n.swap.total) body.push(P.bar(T('node.swap'), P.pct(n.swap.used, n.swap.total), P.bytes(n.swap.used) + ' / ' + P.bytes(n.swap.total)));
    }
    var meta = [];
    if (n.online) meta.push(el('span', { text: T('node.uptime', { v: P.duration(n.uptime) }) }));
    if (n.load) meta.push(el('span', { text: T('node.load', { v: n.load.map(function (x) { return P.num(x, 2); }).join(' / ') }) }));
    if (n.cpuModel) meta.push(el('span', { class: 'px-muted', text: n.cpuModel }));
    if (n.updates != null) meta.push(el('span', { class: n.updates ? 'is-warn' : null, text: n.updates ? T('node.updates', { n: n.updates }) : T('node.no_updates') }));
    else if (n.updatesError) meta.push(el('span', { class: 'px-muted', text: T('node.updates_error') }));
    if (n.error) meta.push(el('span', { class: 'is-error', text: T('node.status_error') }));
    return el('div', { class: 'px-card px-node' + (n.online ? '' : ' is-off'), 'data-node': n.name }, [
      el('div', { class: 'px-head' }, [ic, el('div', { class: 'px-head-text' }, [el('div', { class: 'px-name', text: n.name }), sub ? el('div', { class: 'px-sub', text: sub }) : null]),
        tag(n.online ? T('node.online') : T('node.offline'), n.online ? 'good' : 'error')]),
      body.length ? el('div', { class: 'px-meters' }, body) : null,
      el('div', { class: 'px-meta' }, meta),
    ]);
  }
  function haLine(ha) {
    if (!ha) return null;
    if (ha.error) return el('div', { class: 'px-sub', text: T('ha.unavailable') });
    var t = T('ha.line', { quorum: ha.quorum || '–', master: ha.master || '–', n: ha.services });
    return el('div', { class: 'px-sub' + (ha.errors && ha.errors.length ? ' is-error' : '') }, [t + (ha.errors && ha.errors.length ? ' · ' + T('ha.errors', { list: ha.errors.join(', ') }) : '')]);
  }
  function renderOverview() {
    var box = P.clear($('#px-overview'));
    data.hosts.forEach(function (h) {
      var s = h.snapshot;
      var title = [h.name];
      var info = [];
      if (s && s.cluster && s.cluster.name) info.push(T('ov.cluster', { name: s.cluster.name }) + (s.cluster.quorate === false ? ' · ' + T('ov.no_quorum') : ''));
      if (s && s.version) info.push('Proxmox VE ' + s.version.version);
      if (s) info.push(guestSummary(s));
      var refresh = el('button', { type: 'button', class: 'btn btn-sm', text: T('common.refresh'), on: { click: function (e) { refreshHost(h, e.currentTarget); } } });
      var sec = el('section', { class: 'px-host', 'data-host': String(h.id) }, [
        el('div', { class: 'px-host-head' }, [
          el('div', { class: 'px-head-text' }, [el('h2', { class: 'px-host-name', text: title.join('') }), info.length ? el('div', { class: 'px-sub', text: info.join(' · ') }) : null, hostState(h)]),
          h.enabled ? el('div', { class: 'page-actions' }, [refresh]) : null,
        ]),
        s ? haLine(s.ha) : null,
        s && s.nodes.length ? el('div', { class: 'px-grid' }, s.nodes.map(nodeCard)) : el('div', { class: 'px-empty', text: s ? T('ov.no_nodes') : T('ov.no_data') }),
      ]);
      box.appendChild(sec);
    });
  }
  function refreshHost(h, btn) {
    if (btn) btn.disabled = true;
    return P.api('POST', 'hosts/' + h.id + '/refresh').then(function (r) {
      if (r.result && r.result.ok) P.toast(T('refresh.ok', { name: h.name }));
      else P.toast(T('refresh.failed', { error: (r.result && r.result.error_text) || '' }), 'error');
      return load();
    }).catch(warn).then(function () { if (btn) btn.disabled = false; });
  }

  // ── guests ───────────────────────────────────────────────────────────────
  function renderGuestFilters() {
    var sel = $('#px-g-host');
    var cur = sel.value;
    P.clear(sel);
    sel.appendChild(el('option', { value: '', text: T('guests.host_all') }));
    data.hosts.forEach(function (h) { sel.appendChild(el('option', { value: String(h.id), text: h.name })); });
    if (data.hosts.some(function (h) { return String(h.id) === cur; })) sel.value = cur;
    sel.hidden = data.hosts.length < 2;
  }
  function allGuests() {
    var out = [];
    data.hosts.forEach(function (h) {
      var w = {};
      (h.watched || []).forEach(function (v) { w[v] = true; });
      ((h.snapshot && h.snapshot.guests) || []).forEach(function (g) { out.push({ host: h, g: g, watched: !!w[g.vmid] }); });
    });
    return out;
  }
  function filtered() {
    var q = String($('#px-g-search').value || '').trim().toLowerCase();
    var hid = $('#px-g-host').value, type = $('#px-g-type').value, st = $('#px-g-status').value, onlyW = $('#px-g-watched').checked;
    return allGuests().filter(function (x) {
      if (hid && String(x.host.id) !== hid) return false;
      if (type && x.g.type !== type) return false;
      if (st && (st === 'stopped' ? x.g.status === 'running' : x.g.status !== st)) return false;
      if (onlyW && !x.watched) return false;
      if (q && String(x.g.vmid).indexOf(q) < 0 && String(x.g.name || '').toLowerCase().indexOf(q) < 0 && String(x.g.node || '').toLowerCase().indexOf(q) < 0
        && !(x.g.tags || []).some(function (t) { return String(t).toLowerCase().indexOf(q) >= 0; })) return false;
      return true;
    });
  }
  function actionButtons(x) {
    var g = x.g;
    if (g.template) return [el('span', { class: 'px-muted', text: T('guests.template') })];
    if (!x.host.enabled) return [];
    var list = g.status === 'running' ? ['shutdown', 'reboot', 'stop'] : (g.status === 'stopped' ? ['start'] : []);
    return list.map(function (a) {
      return el('button', {
        type: 'button', class: 'btn btn-sm' + (a === 'stop' ? ' btn-danger' : ''), 'data-action': a, text: T('action.' + a),
        on: { click: function () { openAction(x.host, g, a); } },
      });
    });
  }
  function watchToggle(x) {
    var cb = el('input', { type: 'checkbox', checked: x.watched, 'aria-label': T('guests.watch_label', { vmid: x.g.vmid }) });
    cb.addEventListener('change', function () {
      cb.disabled = true;
      P.api('PUT', 'hosts/' + x.host.id + '/guests/' + x.g.vmid + '/watch', { watched: cb.checked }).then(function (r) {
        x.host.watched = r.watched;
        P.toast(cb.checked ? T('watch.on', { vmid: x.g.vmid }) : T('watch.off', { vmid: x.g.vmid }));
      }).catch(function (e) { cb.checked = !cb.checked; warn(e); }).then(function () { cb.disabled = false; });
    });
    return el('label', { class: 'px-switch' }, [cb, el('span', { class: 'px-switch-ui', 'aria-hidden': 'true' })]);
  }
  function renderGuests() {
    var body = P.clear($('#px-g-body'));
    var list = filtered();
    var multi = data.hosts.length > 1;
    list.forEach(function (x) {
      var g = x.g;
      var name = el('td', { class: 'px-g-name' }, [el('span', { text: g.name || '–' })]);
      if (g.lock) name.appendChild(tag(T('guests.lock', { lock: g.lock }), 'warn'));
      if (g.hastate) name.appendChild(tag('HA ' + g.hastate));
      (g.tags || []).slice(0, 3).forEach(function (t) { name.appendChild(el('span', { class: 'px-tagchip', text: t })); });
      body.appendChild(el('tr', { 'data-vmid': String(g.vmid), 'data-host': String(x.host.id) }, [
        el('td', { class: 'px-mono', text: String(g.vmid) }),
        name,
        el('td', { text: kind(g.type) }),
        el('td', { text: (multi ? x.host.name + ' / ' : '') + (g.node || '–') }),
        el('td', null, [tag(statusText(g.status), guestStatusTone(g.status))]),
        el('td', { text: g.status === 'running' && g.cpu != null ? P.num(g.cpu * 100, 1) + ' %' : '–' }),
        el('td', { text: g.status === 'running' ? P.bytes(g.mem) + ' / ' + P.bytes(g.maxmem) : P.bytes(g.maxmem) }),
        el('td', { text: g.status === 'running' ? P.duration(g.uptime) : '–' }),
        el('td', null, [watchToggle(x)]),
        el('td', { class: 'px-actions-cell' }, actionButtons(x)),
      ]));
    });
    var empty = $('#px-g-empty');
    var total = allGuests().length;
    empty.hidden = list.length > 0;
    empty.textContent = total ? T('guests.none_match') : T('guests.none');
    $('#px-g-table').hidden = !list.length;
  }
  ['#px-g-search', '#px-g-host', '#px-g-type', '#px-g-status', '#px-g-watched'].forEach(function (id) {
    $(id).addEventListener(id === '#px-g-search' ? 'input' : 'change', function () { if (data) renderGuests(); });
  });

  // ── storage and backups ──────────────────────────────────────────────────
  function renderStorage() {
    var box = P.clear($('#px-storage'));
    var rows = [];
    data.hosts.forEach(function (h) { ((h.snapshot && h.snapshot.storages) || []).forEach(function (s) { rows.push({ host: h, s: s }); }); });
    if (!rows.length) box.appendChild(el('div', { class: 'px-empty', text: T('storage.none') }));
    else {
      var th = data.config.storage_threshold;
      box.appendChild(el('div', { class: 'px-table-wrap' }, [el('table', { class: 'px-table' }, [
        el('thead', null, [el('tr', null, [T('storage.col_name'), T('storage.col_node'), T('storage.col_type'), T('storage.col_status'), T('storage.col_usage')].map(function (c) { return el('th', { text: c }); }))]),
        el('tbody', null, rows.map(function (x) {
          var s = x.s;
          var p = P.pct(s.used, s.total);
          var usage = s.total ? P.bar('', p, P.bytes(s.used) + ' / ' + P.bytes(s.total)) : el('span', { class: 'px-muted', text: '–' });
          return el('tr', { class: p != null && p >= th ? 'is-full' : null }, [
            el('td', { class: 'px-mono', text: s.storage }),
            el('td', { text: (data.hosts.length > 1 ? x.host.name + ' / ' : '') + (s.shared ? T('storage.shared', { n: (s.nodes || []).length }) : (s.node || '–')) }),
            el('td', { text: (s.type || '–') + (s.content ? ' · ' + s.content : '') }),
            el('td', null, [tag(s.status === 'available' ? T('storage.available') : statusText(s.status), s.status === 'available' ? 'good' : 'warn')]),
            el('td', { class: 'px-usage' }, [usage]),
          ]);
        })),
      ])]));
    }
    var bbox = P.clear($('#px-backups'));
    var backups = [];
    data.hosts.forEach(function (h) {
      var names = {};
      ((h.snapshot && h.snapshot.guests) || []).forEach(function (g) { names[g.vmid] = g.name; });
      ((h.snapshot && h.snapshot.backups) || []).forEach(function (b) { backups.push({ host: h, b: b, name: b.vmid != null ? names[b.vmid] : null }); });
    });
    backups.sort(function (a, b) { return (b.b.endtime || 0) - (a.b.endtime || 0); });
    if (!backups.length) { bbox.appendChild(el('div', { class: 'px-empty', text: T('backups.none') })); return; }
    bbox.appendChild(el('div', { class: 'px-table-wrap' }, [el('table', { class: 'px-table' }, [
      el('thead', null, [el('tr', null, [T('backups.col_end'), T('backups.col_node'), T('backups.col_guest'), T('backups.col_status'), T('backups.col_duration')].map(function (c) { return el('th', { text: c }); }))]),
      el('tbody', null, backups.slice(0, 30).map(function (x) {
        var b = x.b;
        return el('tr', null, [
          el('td', { text: P.when(b.endtime * 1000) }),
          el('td', { text: (data.hosts.length > 1 ? x.host.name + ' / ' : '') + (b.node || '–') }),
          el('td', { text: b.vmid != null ? String(b.vmid) + (x.name ? ' · ' + x.name : '') : T('backups.all') }),
          el('td', null, [tag(b.ok ? T('backups.ok') : T('backups.failed'), b.ok ? 'good' : 'error'), b.ok ? null : el('span', { class: 'px-small is-error', text: ' ' + (b.status || '') })]),
          el('td', { text: b.endtime && b.starttime ? P.duration(b.endtime - b.starttime) : '–' }),
        ]);
      })),
    ])]));
  }

  // ── connections ──────────────────────────────────────────────────────────
  function renderHosts() {
    var c = data.config;
    $('#px-hosts-info').textContent = T('hosts.info', { sec: c.poll_interval, storage: c.storage_threshold });
    var box = P.clear($('#px-hosts'));
    if (!data.hosts.length) { box.appendChild(el('div', { class: 'px-empty', text: T('hosts.empty') })); return; }
    data.hosts.forEach(function (h) {
      var ic = el('div', { class: 'px-ic' }); ic.appendChild(P.svg(ICON_SERVER, 20));
      var meta = [
        el('span', { text: T('host.target_line', { target: h.target_label || T('host.no_target') }) }),
        el('span', { class: 'px-mono', text: h.token_id }),
        el('span', { text: h.has_secret ? T('host.secret_stored') : T('host.secret_missing') }),
      ];
      if (h.version) meta.push(el('span', { text: 'Proxmox VE ' + h.version + (h.cluster_name ? ' · ' + T('ov.cluster', { name: h.cluster_name }) : '') }));
      box.appendChild(el('div', { class: 'px-card' + (h.enabled ? '' : ' is-disabled'), 'data-host': String(h.id) }, [
        el('div', { class: 'px-head' }, [ic, el('div', { class: 'px-head-text' }, [el('div', { class: 'px-name', text: h.name }), hostState(h)])]),
        el('div', { class: 'px-meta' }, meta),
        el('div', { class: 'px-foot' }, [
          h.enabled ? el('button', { type: 'button', class: 'btn btn-sm', text: T('common.refresh'), on: { click: function (e) { refreshHost(h, e.currentTarget); } } }) : null,
          el('button', { type: 'button', class: 'btn btn-sm', 'data-edit': String(h.id), text: T('common.edit'), on: { click: function () { openHost(h); } } }),
        ]),
      ]));
    });
  }
  function renderActions() {
    var box = P.clear($('#px-actions'));
    if (!data.actions.length) { box.appendChild(el('div', { class: 'px-empty', text: T('actions.none') })); return; }
    box.appendChild(el('div', { class: 'px-table-wrap' }, [el('table', { class: 'px-table' }, [
      el('thead', null, [el('tr', null, [T('actions.col_time'), T('actions.col_guest'), T('actions.col_action'), T('actions.col_user'), T('actions.col_result')].map(function (c) { return el('th', { text: c }); }))]),
      el('tbody', null, data.actions.map(function (a) {
        var tone = a.status === 'ok' ? 'good' : (a.status === 'running' ? null : 'error');
        return el('tr', null, [
          el('td', { text: P.when(a.started_at) }),
          el('td', { text: kind(a.guest_type) + ' ' + a.vmid + (a.guest_name ? ' · ' + a.guest_name : '') + ' (' + a.node + ')' }),
          el('td', { text: T('action.' + a.action) }),
          el('td', { text: a.user_name || '–' }),
          el('td', null, [tag(a.status_text || a.status, tone), a.status === 'error' && a.exitstatus ? el('span', { class: 'px-small is-error', text: ' ' + a.exitstatus }) : null]),
        ]);
      })),
    ])]));
  }

  // ── connection dialog ────────────────────────────────────────────────────
  function fillTargets(sel, current) {
    P.clear(sel);
    if (!data.targets.length) sel.appendChild(el('option', { value: '', text: T('host.no_target') }));
    data.targets.forEach(function (t) { sel.appendChild(el('option', { value: String(t.index), text: t.label })); });
    if (current != null) sel.value = String(current);
  }
  function openHost(h) {
    editHost = h || null;
    $('#px-host-title').textContent = h ? T('host.edit') : T('host.add');
    $('#px-h-name').value = h ? h.name : '';
    fillTargets($('#px-h-target'), h ? h.target_index : null);
    $('#px-h-token').value = h ? h.token_id : '';
    $('#px-h-secret').value = '';
    $('#px-h-secret-hint').textContent = h && h.has_secret ? T('host.secret_keep') : T('host.secret_hint');
    $('#px-h-enabled').checked = h ? h.enabled : true;
    $('#px-h-enabled-row').hidden = !h;
    $('#px-h-delete').hidden = !h;
    setMsg('#px-h-test-msg', '');
    P.openModal('px-host-modal');
  }
  function hostBody() {
    var idx = $('#px-h-target').value;
    var b = { name: $('#px-h-name').value, target_index: idx === '' ? null : Number(idx), token_id: $('#px-h-token').value.trim(), token_secret: $('#px-h-secret').value.trim() };
    if (editHost) b.enabled = $('#px-h-enabled').checked;
    return b;
  }
  $('#px-host-add').addEventListener('click', function () { openHost(null); });
  $('#px-empty-add').addEventListener('click', function () { openHost(null); });
  $('#px-h-test').addEventListener('click', function () {
    var btn = $('#px-h-test');
    var b = hostBody();
    var body = { target_index: b.target_index, token_id: b.token_id, token_secret: b.token_secret };
    if (editHost) body.host_id = editHost.id;
    btn.disabled = true;
    setMsg('#px-h-test-msg', T('host.testing'));
    P.api('POST', 'hosts/test', body).then(function (r) {
      var x = r.result || {};
      var parts = [T('test.ok', { version: x.version || '?' })];
      if (x.cluster) parts.push(T('test.cluster', { name: x.cluster, quorate: x.quorate ? T('test.quorate') : T('ov.no_quorum') }));
      parts.push(T('test.nodes', { list: (x.nodes || []).join(', ') || '–' }));
      setMsg('#px-h-test-msg', parts.join(' · '), 'good');
    }).catch(function (e) { setMsg('#px-h-test-msg', errText(e), 'error'); }).then(function () { btn.disabled = false; });
  });
  $('#px-h-save').addEventListener('click', function () {
    var btn = $('#px-h-save');
    var b = hostBody();
    if (editHost && !b.token_secret) delete b.token_secret;
    btn.disabled = true;
    var req = editHost ? P.api('PUT', 'hosts/' + editHost.id, b) : P.api('POST', 'hosts', b);
    req.then(function (r) {
      P.closeModal('px-host-modal');
      P.toast(T('host.saved'));
      return load().then(function () { if (r.host && r.host.enabled) return refreshHost(r.host); });
    }).catch(warn).then(function () { btn.disabled = false; });
  });
  $('#px-h-delete').addEventListener('click', function () {
    if (!editHost) return;
    var h = editHost;
    P.confirm(T('host.delete_confirm', { name: h.name }), T('common.delete'), true).then(function (ok) {
      if (!ok) return null;
      return P.api('DELETE', 'hosts/' + h.id).then(function () { P.closeModal('px-host-modal'); P.toast(T('host.deleted')); return load(); });
    }).catch(warn);
  });

  // ── action dialog ────────────────────────────────────────────────────────
  function stopFollowing() { if (actionTimer) { clearTimeout(actionTimer); actionTimer = null; } }
  function openAction(host, g, action) {
    stopFollowing();
    pending = { host: host, guest: g, action: action };
    var label = kind(g.type) + ' ' + g.vmid + (g.name ? ' (' + g.name + ')' : '');
    $('#px-a-title').textContent = T('action.title_' + action, { guest: label });
    $('#px-a-msg').textContent = T('action.msg_' + action, { guest: label, node: g.node || '–' });
    var hard = action === 'stop';
    $('#px-a-warn').hidden = !hard;
    $('#px-a-hard-row').hidden = !hard;
    $('#px-a-hard').checked = false;
    $('#px-a-progress').hidden = true;
    $('#px-a-progress').textContent = '';
    $('#px-a-progress').removeAttribute('data-tone');
    var ok = $('#px-a-ok');
    ok.hidden = false;
    ok.textContent = T('action.' + action);
    ok.className = 'btn ' + (hard ? 'btn-danger' : 'btn-primary');
    ok.disabled = hard;
    $('#px-a-cancel').textContent = T('common.cancel');
    P.openModal('px-action-modal');
  }
  $('#px-a-hard').addEventListener('change', function () { $('#px-a-ok').disabled = !$('#px-a-hard').checked; });
  $('#px-action-modal').addEventListener('px-close', function () { stopFollowing(); pending = null; });
  function showProgress(a) {
    var p = $('#px-a-progress');
    p.hidden = false;
    if (a.status === 'running') { p.textContent = T('action.running'); p.setAttribute('data-tone', ''); return; }
    p.textContent = a.status === 'ok' ? T('action.done') : (a.status === 'timeout' ? T('action.timeout') : T('action.failed', { error: a.exitstatus || '–' }));
    p.setAttribute('data-tone', a.status === 'ok' ? 'good' : 'error');
    $('#px-a-cancel').textContent = T('common.close');
    load();
  }
  function follow(a, started) {
    showProgress(a);
    if (a.status !== 'running') return;
    if (Date.now() - started > 6 * 60000) { showProgress({ status: 'timeout' }); return; }
    actionTimer = setTimeout(function () {
      P.api('GET', 'actions/' + a.id).then(function (r) { if (pending) follow(r.action, started); }).catch(function (e) { setMsg('#px-a-progress', errText(e), 'error'); });
    }, 2000);
  }
  $('#px-a-ok').addEventListener('click', function () {
    if (!pending) return;
    var p = pending;
    var body = { action: p.action, confirm: true };
    if (p.action === 'stop') {
      if (!$('#px-a-hard').checked) return;
      body.confirm_hard = true;
    }
    $('#px-a-ok').disabled = true;
    $('#px-a-ok').hidden = true;
    $('#px-a-hard-row').hidden = true;
    showProgress({ status: 'running' });
    P.api('POST', 'hosts/' + p.host.id + '/guests/' + p.guest.vmid + '/action', body).then(function (r) {
      follow(r.action, Date.now());
    }).catch(function (e) {
      var pr = $('#px-a-progress');
      pr.textContent = errText(e);
      pr.setAttribute('data-tone', 'error');
      $('#px-a-cancel').textContent = T('common.close');
    });
  });

  // ── start ────────────────────────────────────────────────────────────────
  load();
  setInterval(function () {
    // keep the page current, but never under an open dialog
    if (document.hidden || $$('.modal-overlay').some(function (m) { return !m.hidden; })) return;
    load();
  }, REFRESH_MS);
}());
