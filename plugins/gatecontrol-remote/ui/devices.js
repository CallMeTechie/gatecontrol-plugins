/* Admin page "Geräte": every target with its state, connect, wake, check, and the editor with all settings of a target.
   1.1: the Windows PCs the app registered (owner, "Angemeldet von der App", nur mit Code / ohne Code, "„Ohne Code“ sperren").
   1.2: SSH in GateControl's terminal (tmux, host key, a key made in GateControl, switching old Guacamole devices), recording. */
(function () {
  'use strict';
  var P = window.RM;
  var T = P.T, el = P.el, $ = P.$;
  var S = { devices: [], gateways: [], pools: [], gwList: false, v3: false };

  // ─── the editor: tabs and fields (the settings of the former Remote Desktops) ───
  var GRAPHIC = function (v) { return v.protocol === 'rdp' || v.protocol === 'vnc'; };
  var RDP = function (v) { return v.protocol === 'rdp'; };
  var SSH = function (v) { return v.protocol === 'ssh'; };
  var TERM = function (v) { return v.protocol === 'ssh' && v.ssh_engine === 'term'; };
  var opts = function (prefix, list) { return list.map(function (x) { return { v: x, label: T(prefix + x) }; }); };
  var TABS = [
    { id: 'connection', fields: [
      { key: 'name', type: 'text', top: true, max: 100, wide: true },
      { key: 'protocol', type: 'select', top: true, options: opts('proto.', ['rdp', 'vnc', 'ssh', 'telnet']) },
      { key: 'enabled', type: 'check', top: true },
      { key: 'host', type: 'text', max: 253, hint: 'f.host_hint' },
      { key: 'port', type: 'number', min: 1, max: 65535 },
      { key: 'access_mode', type: 'select', options: opts('mode.', ['internal', 'external', 'both', 'gateway']), wide: true },
      { key: 'external_hostname', type: 'text', max: 253, show: function (v) { return v.access_mode === 'external' || v.access_mode === 'both'; } },
      { key: 'external_port', type: 'number', min: 1, max: 65535, show: function (v) { return v.access_mode === 'external' || v.access_mode === 'both'; } },
      { key: 'gateway', type: 'gateway', show: function (v) { return v.access_mode === 'gateway'; }, wide: true },
      { key: 'gateway_listen_port', type: 'number', min: 1, max: 65535, hint: 'f.gateway_listen_port_hint', show: function (v) { return v.access_mode === 'gateway'; } },
      { key: 'health_check_enabled', type: 'check' },
      { key: 'description', type: 'textarea', max: 500, wide: true },
      { key: 'tags', type: 'tags', wide: true },
    ] },
    { id: 'auth', fields: [
      { key: 'credential_mode', type: 'select', options: opts('cred.', ['none', 'user_only', 'full']), show: RDP, hint: 'f.credential_mode_hint' },
      { key: 'cred_state', type: 'credstate', wide: true },
      { key: 'username', type: 'secret', cred: true, max: 1024 },
      { key: 'password', type: 'password', cred: true, max: 1024 },
      { key: 'privateKey', type: 'secretarea', cred: true, max: 16384, show: SSH, wide: true },
      { key: 'passphrase', type: 'password', cred: true, max: 1024, show: SSH },
      { key: 'domain', type: 'text', max: 256, show: RDP },
      { key: 'cred_clear', type: 'check', cred: true, wide: true },
    ] },
    { id: 'display', show: GRAPHIC, fields: [
      { key: 'resolution_mode', type: 'select', options: opts('res.', ['fullscreen', 'fixed', 'dynamic']), show: RDP },
      { key: 'resolution_width', type: 'number', min: 1, max: 7680, show: function (v) { return RDP(v) && v.resolution_mode === 'fixed'; } },
      { key: 'resolution_height', type: 'number', min: 1, max: 7680, show: function (v) { return RDP(v) && v.resolution_mode === 'fixed'; } },
      { key: 'color_depth', type: 'select', options: [8, 15, 16, 24, 32].map(function (n) { return { v: n, label: T('f.bits', { n: n }) }; }) },
      { key: 'multi_monitor', type: 'check', show: RDP },
    ] },
    { id: 'resources', show: RDP, fields: [
      { key: 'redirect_clipboard', type: 'check' },
      { key: 'redirect_printers', type: 'check' },
      { key: 'redirect_drives', type: 'check' },
      { key: 'redirect_usb', type: 'check' },
      { key: 'redirect_smartcard', type: 'check' },
      { key: 'audio_mode', type: 'select', options: opts('audio.', ['local', 'remote', 'off']) },
    ] },
    { id: 'performance', show: RDP, fields: [
      { key: 'network_profile', type: 'select', options: opts('net.', ['auto', 'lan', 'broadband', 'modem']) },
      { key: 'bandwidth_limit', type: 'number', min: 0, max: 10000000 },
      { key: 'nla_enabled', type: 'check' },
      { key: 'disable_wallpaper', type: 'check' },
      { key: 'disable_themes', type: 'check' },
      { key: 'disable_animations', type: 'check' },
    ] },
    { id: 'session', show: RDP, fields: [
      { key: 'session_timeout', type: 'number', min: 0, max: 100000 },
      { key: 'admin_session', type: 'check' },
      { key: 'remote_app', type: 'text', max: 256 },
      { key: 'start_program', type: 'text', max: 512 },
      { key: 'gateway_host', type: 'text', max: 253, hint: 'f.rdg_hint' },
      { key: 'gateway_port', type: 'number', min: 1, max: 65535 },
    ] },
    { id: 'wol', fields: [
      { key: 'wol_enabled', type: 'check', show: GRAPHIC },
      { key: 'wol_mac_address', type: 'text', max: 17, show: function (v) { return GRAPHIC(v) && v.wol_enabled; } },
      { key: 'maintenance_enabled', type: 'check', wide: true },
      { key: 'maintenance_schedule', type: 'textarea', max: 1000, hint: 'f.maintenance_hint', show: function (v) { return v.maintenance_enabled; }, wide: true },
      { key: 'credential_rotation_enabled', type: 'check', wide: true },
      { key: 'credential_rotation_days', type: 'number', min: 1, max: 3650, show: function (v) { return v.credential_rotation_enabled; } },
    ] },
    { id: 'browser', fields: [
      { key: 'browser_enabled', type: 'check', wide: true, hint: 'f.browser_hint' },
      { key: 'browser_clipboard', type: 'check', show: function (v) { return v.browser_enabled; } },
      { key: 'rdp_disable_audio', type: 'check', show: function (v) { return v.browser_enabled && RDP(v); } },
    ] },
    // 1.2: GateControl's terminal (gc.remote version 3) instead of Guacamole, tmux, the host key and a key made in GateControl
    { id: 'terminal', show: SSH, fields: [
      { key: 'ssh_engine', type: 'select', options: opts('engine.', ['term', 'guac']), hint: 'f.ssh_engine_hint', wide: true },
      { key: 'tmux_enabled', type: 'check', show: TERM, hint: 'f.tmux_enabled_hint', wide: true },
      { key: 'tmux_name', type: 'text', max: 32, show: function (v) { return TERM(v) && v.tmux_enabled; }, hint: 'f.tmux_name_hint' },
      { key: 'ssh_info', type: 'sshinfo', wide: true },
    ] },
    { id: 'recording', fields: [
      { key: 'recording', type: 'select', options: opts('rec.', ['off', 'optional', 'always']), hint: 'f.recording_hint', wide: true },
      { key: 'rec_always_note', type: 'note', text: 'f.recording_always_hint', show: function (v) { return v.recording === 'always'; }, wide: true },
    ] },
    { id: 'notes', fields: [{ key: 'notes', type: 'textarea', max: 2000, wide: true }] },
  ];
  var TOP = ['name', 'protocol', 'enabled'];
  var CRED_KEYS = ['username', 'password', 'privateKey', 'passphrase'];

  function fieldInput(f, id) {
    var a = { id: id, 'data-key': f.key };
    if (f.type === 'select') return el('select', Object.assign({ class: 'form-select' }, a), f.options.map(function (o) { return el('option', { value: String(o.v), text: o.label }); }));
    if (f.type === 'textarea' || f.type === 'secretarea') return el('textarea', Object.assign({ class: 'form-input', maxlength: String(f.max || 1000), spellcheck: 'false', autocomplete: 'off' }, a));
    if (f.type === 'number') return el('input', Object.assign({ class: 'form-input', type: 'number', min: String(f.min), max: String(f.max), step: '1' }, a));
    if (f.type === 'check') return el('input', Object.assign({ type: 'checkbox' }, a));
    if (f.type === 'password') return el('input', Object.assign({ class: 'form-input', type: 'password', maxlength: String(f.max), autocomplete: 'new-password' }, a));
    return el('input', Object.assign({ class: 'form-input', type: 'text', maxlength: String(f.max || 253), autocomplete: 'off', spellcheck: 'false' }, a));
  }

  function gatewayInput(id) {
    if (!S.gwList) return el('input', { class: 'form-input', type: 'number', min: '1', id: id, 'data-key': 'gateway', placeholder: T('f.gateway_peer_id') });
    var o = [el('option', { value: '', text: T('f.gateway_pick') })];
    S.gateways.forEach(function (g) { o.push(el('option', { value: 'peer:' + g.peerId, text: g.name + (g.online === false ? ' (' + T('state.offline') + ')' : '') })); });
    S.pools.forEach(function (p) { o.push(el('option', { value: 'pool:' + p.poolId, text: T('f.pool', { name: p.name }) })); });
    return el('select', { class: 'form-select', id: id, 'data-key': 'gateway' }, o);
  }

  /** 1.2: the terminal of an SSH device — the pinned host key (reset), a key made in GateControl (public half to copy), a test. */
  function sshInfo(dev, username) {
    var box = el('div', { class: 'rm-sshinfo' });
    var x = dev && dev.ssh;
    if (!dev || !x) { box.appendChild(el('p', { class: 'rm-hint', text: T('f.ssh_info_new') })); return box; }
    if (!x.available) { box.appendChild(el('p', { class: 'rm-note', text: T('f.ssh_info_old') })); return box; }
    function draw(d) {
      x = d.ssh;
      P.clear(box);
      var hk = x.hostKey;
      box.appendChild(el('p', { class: 'rm-hint', text: hk ? T('f.hostkey_pinned', { fp: hk.alg + ' SHA256:' + hk.sha256, when: P.when(hk.pinnedAt) }) : T('f.hostkey_none') }));
      var acts = el('div', { class: 'rm-actions' });
      if (hk) {
        acts.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('f.hostkey_reset'), on: { click: function (ev) {
          var b = ev.currentTarget;
          P.confirmDialog(T('f.hostkey_reset_q', { name: dev.name }), T('f.hostkey_reset')).then(function (ok) {
            if (!ok) return null;
            b.disabled = true;
            return P.api('DELETE', 'admin/devices/' + dev.id + '/hostkey').then(function (r) { P.toast(T('f.hostkey_reset_done')); draw(r.device); });
          }).catch(P.warn).then(function () { b.disabled = false; });
        } } }));
      }
      acts.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: x.publicKey ? T('f.key_renew') : T('f.key_make'), on: { click: function (ev) {
        var b = ev.currentTarget;
        var go = x.publicKey ? P.confirmDialog(T('f.key_renew_q'), T('f.key_renew')) : Promise.resolve(true);
        go.then(function (ok) {
          if (!ok) return null;
          b.disabled = true;
          return P.api('POST', 'admin/devices/' + dev.id + '/key', { username: username() || undefined }).then(function (r) { P.toast(T('f.key_made')); draw(r.device); });
        }).catch(P.warn).then(function () { b.disabled = false; });
      } } }));
      if (x.engine === 'guac') {
        acts.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('f.term_test'), on: { click: function (ev) {
          var b = ev.currentTarget;
          b.disabled = true;
          P.api('POST', 'admin/devices/' + dev.id + '/connect', { engine: 'term' }).then(function (r) { return P.openSession(r.session.ref, box); }).catch(P.warn).then(function () { b.disabled = false; });
        } } }));
      }
      box.appendChild(acts);
      if (x.publicKey) {
        box.appendChild(el('label', { class: 'form-label', for: 'rm-pubkey', text: T('f.public_key') }));
        box.appendChild(el('textarea', { class: 'form-input rm-pubkey', id: 'rm-pubkey', readonly: true, rows: '3', spellcheck: 'false', value: x.publicKey }));
        box.appendChild(el('p', { class: 'rm-hint', text: T('f.public_key_hint') }));
      }
      if (x.termTestedAt && x.engine === 'guac') box.appendChild(el('p', { class: 'rm-hint', text: T('f.term_tested', { when: P.when(x.termTestedAt) }) }));
    }
    draw(dev);
    return box;
  }

  /** 1.2: move SSH devices from Guacamole to GateControl's terminal (ids: those, none: all). */
  function switchEngine(ids, name) {
    return P.confirmDialog(ids ? T('dev.switch_q', { name: name }) : T('dev.switch_all_q'), T('dev.switch')).then(function (ok) {
      if (!ok) return null;
      return P.api('POST', 'admin/devices/ssh-engine', ids ? { engine: 'term', ids: ids } : { engine: 'term' }).then(function (r) {
        P.toast(T('dev.switched', { n: r.switched }));
        S.devices = r.devices || S.devices;
        draw();
      });
    }).catch(P.warn);
  }

  function editor(dev) {
    var v = dev ? Object.assign({ name: dev.name, protocol: dev.protocol, enabled: dev.enabled }, dev.config) : { name: '', protocol: 'rdp', enabled: true, port: 3389, access_mode: 'internal', credential_mode: 'full', resolution_mode: 'fullscreen', color_depth: 32, redirect_clipboard: true, audio_mode: 'local', network_profile: 'auto', nla_enabled: true, health_check_enabled: true, tags: [], ssh_engine: 'term', tmux_enabled: true, recording: 'off' };
    var cred = dev ? dev.credential : { set: false, has: {}, readable: true };
    var inputs = {};
    var rows = {};
    var panels = {};
    var tabBtns = {};
    var current = 'connection';
    var errBox = el('p', { class: 'rm-field-error', role: 'alert', hidden: true });

    function values() {
      var out = {};
      Object.keys(inputs).forEach(function (k) {
        var n = inputs[k];
        var f = n._f;
        if (f.type === 'check') out[k] = n.checked;
        else if (f.type === 'number') out[k] = n.value === '' ? null : parseInt(n.value, 10);
        else if (f.type === 'select') out[k] = /^\d+$/.test(n.value) && k === 'color_depth' ? parseInt(n.value, 10) : n.value;
        else out[k] = n.value;
      });
      return out;
    }
    function refresh() {
      var cur = values();
      TABS.forEach(function (tab) {
        var on = !tab.show || tab.show(cur);
        tabBtns[tab.id].hidden = !on;
        if (!on && current === tab.id) select('connection');
        tab.fields.forEach(function (f) { if (rows[f.key]) rows[f.key].hidden = !!(f.show && !f.show(cur)); });
      });
    }
    function select(id) {
      current = id;
      Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== id; tabBtns[k].setAttribute('aria-selected', k === id ? 'true' : 'false'); });
    }
    var top = el('div', { class: 'rm-grid' });
    var tabs = el('div', { class: 'rm-dtabs', role: 'tablist' });
    var body = el('div');
    TABS.forEach(function (tab) {
      tabBtns[tab.id] = el('button', { type: 'button', role: 'tab', text: T('tab.' + tab.id), on: { click: function () { select(tab.id); } } });
      tabs.appendChild(tabBtns[tab.id]);
      var grid = el('div', { class: 'rm-grid' });
      panels[tab.id] = el('div', { role: 'tabpanel' }, [grid]);
      body.appendChild(panels[tab.id]);
      tab.fields.forEach(function (f) {
        var id = 'rm-f-' + f.key;
        var row;
        if (f.type === 'credstate') {
          var has = cred.has || {};
          var names = ['username', 'password', 'privateKey', 'passphrase'].filter(function (k) { return has[k]; }).map(function (k) { return T('f.' + k); });
          row = el('p', { class: cred.readable === false ? 'rm-note' : 'rm-hint', text: cred.readable === false ? T('f.cred_unreadable') : (names.length ? T('f.cred_stored', { list: names.join(', ') }) : T('f.cred_none')) });
        } else if (f.type === 'note') {
          row = el('p', { class: 'rm-note', text: T(f.text) });
        } else if (f.type === 'sshinfo') {
          row = sshInfo(dev, function () { return inputs.username ? inputs.username.value : ''; });
        } else {
          var input = f.type === 'gateway' ? gatewayInput(id) : fieldInput(f, id);
          input._f = f;
          inputs[f.key] = input;
          var label = T('f.' + f.key);
          if (f.type === 'check') row = el('label', { class: 'check' }, [input, el('span', { text: label })]);
          else row = el('div', { class: 'form-group' }, [el('label', { class: 'form-label', for: id, text: label }), input]);
          if (f.hint) row.appendChild(el('p', { class: 'rm-hint', text: T(f.hint) }));
          if (f.cred && f.type !== 'check' && cred.set) input.setAttribute('placeholder', T('f.unchanged'));
          // values
          if (f.type === 'gateway') input.value = v.gateway_pool_id ? (S.gwList ? 'pool:' + v.gateway_pool_id : '') : (v.gateway_peer_id ? (S.gwList ? 'peer:' + v.gateway_peer_id : String(v.gateway_peer_id)) : '');
          else if (f.type === 'check') input.checked = !!v[f.key];
          else if (f.type === 'tags') input.value = (v.tags || []).join(', ');
          else if (!f.cred && v[f.key] != null) input.value = String(v[f.key]);
          input.addEventListener('change', refresh);
          if (f.key === 'protocol') input.addEventListener('change', function () { if (!dev) inputs.port.value = String({ rdp: 3389, vnc: 5900, ssh: 22, telnet: 23 }[input.value] || 3389); });
        }
        if (f.wide) row.classList.add('rm-wide-field');
        rows[f.key] = row;
        (f.top ? top : grid).appendChild(row);
      });
    });
    var content = el('div', null, [top, tabs, body, errBox,
      dev && dev.source === 'import' ? el('p', { class: 'rm-hint', text: T('dev.imported_hint') }) : null]);
    select('connection');
    refresh();

    function collect() {
      var cur = values();
      var config = {};
      Object.keys(cur).forEach(function (k) {
        var f = inputs[k]._f;
        if (TOP.indexOf(k) >= 0 || f.cred || f.type === 'credstate') return;
        if (f.type === 'gateway') {
          var g = String(cur.gateway || '');
          var mp = /^peer:(\d+)$/.exec(g);
          var ml = /^pool:(\d+)$/.exec(g);
          config.gateway_peer_id = mp ? parseInt(mp[1], 10) : (/^\d+$/.test(g) ? parseInt(g, 10) : null);
          config.gateway_pool_id = ml ? parseInt(ml[1], 10) : null;
          return;
        }
        if (f.type === 'tags') { config.tags = String(cur.tags || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); return; }
        config[k] = cur[k];
      });
      var out = { name: cur.name.trim(), protocol: cur.protocol, enabled: cur.enabled, config: config };
      var c = {};
      if (cur.cred_clear) CRED_KEYS.forEach(function (k) { c[k] = ''; });
      else CRED_KEYS.forEach(function (k) { if (inputs[k] && cur[k] !== '') c[k] = cur[k]; });
      if (Object.keys(c).length) out.credentials = c;
      return out;
    }

    function tabOf(key) {
      var hit = null;
      TABS.forEach(function (t) { t.fields.forEach(function (f) { if (f.key === key || (f.key === 'gateway' && /^gateway_(peer|pool)_id$/.test(key))) hit = t.id; }); });
      return hit;
    }

    return new Promise(function (resolve) {
      var ov;
      var save = el('button', { type: 'button', class: 'btn btn-primary', text: T('common.save') });
      var cancel = el('button', { type: 'button', class: 'btn', text: T('common.cancel'), on: { click: function () { ov.remove(); resolve(null); } } });
      save.addEventListener('click', function () {
        save.disabled = true;
        errBox.hidden = true;
        Object.keys(tabBtns).forEach(function (k) { tabBtns[k].removeAttribute('data-error'); });
        var body2 = collect();
        P.api(dev ? 'PUT' : 'POST', 'admin/devices' + (dev ? '/' + dev.id : ''), body2).then(function (r) { ov.remove(); P.toast(T('common.saved')); resolve(r.device); }).catch(function (e) {
          save.disabled = false;
          var d = (e && e.data) || {};
          errBox.textContent = P.errText(e) + (d.field ? ' (' + T('f.' + d.field.replace(/^credentials\./, '')) + ')' : '') + (d.suggestedPort ? ' ' + T('f.suggested_port', { port: d.suggestedPort }) : '');
          errBox.hidden = false;
          var t = d.field && tabOf(d.field.replace(/^credentials\./, ''));
          if (t) { tabBtns[t].setAttribute('data-error', '1'); select(t); }
        });
      });
      ov = el('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': dev ? T('dev.edit') : T('dev.add') }, [
        el('div', { class: 'modal rm-wide' }, [
          el('div', { class: 'modal-body' }, [el('h2', { class: 'rm-card-title', text: dev ? T('dev.edit_name', { name: dev.name }) : T('dev.add') }), content]),
          el('div', { class: 'modal-foot' }, [cancel, save]),
        ]),
      ]);
      document.body.appendChild(ov);
      inputs.name.focus();
    });
  }

  // ─── the list ───
  function address(d) {
    var c = d.config;
    if (c.access_mode === 'gateway') {
      var g = S.gateways.filter(function (x) { return x.peerId === c.gateway_peer_id; })[0];
      var p = S.pools.filter(function (x) { return x.poolId === c.gateway_pool_id; })[0];
      return T('dev.via_gateway', { host: c.host + ':' + c.port, gateway: g ? g.name : (p ? p.name : '#' + (c.gateway_peer_id || c.gateway_pool_id || '?')) });
    }
    if (c.access_mode === 'external') return T('dev.external', { host: (c.external_hostname || '–') + ':' + (c.external_port || c.port) });
    if (c.access_mode === 'both') return c.host + ':' + c.port + ' · ' + T('dev.external', { host: (c.external_hostname || '–') + ':' + (c.external_port || c.port) });
    return c.host + ':' + c.port;
  }

  function busy(b, p) { b.disabled = true; return p.catch(P.warn).then(function () { b.disabled = false; }); }

  function row(d) {
    var acts = el('div', { class: 'rm-actions' });
    var h = d.host;
    // a PC asks for its code (the administrator, too); "Verbinden" only "ohne Code"; a phone (1.3) always asks its person:
    // the administrator connects from the portal tab like everybody else
    // 1.5: a PC that only shares its screen (Windows Home) asks its person like a phone — from the portal tab, too
    if (d.config.browser_enabled && d.enabled && (!h || (h.platform !== 'android' && d.protocol === 'rdp' && h.rdpOffered !== false && h.connect === 'open' && h.registered && h.online && h.rdpEnabled !== false))) {
      var cb = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: T('dev.connect') });
      cb.addEventListener('click', function () {
        busy(cb, P.api('POST', 'admin/devices/' + d.id + '/connect', {}).then(function (r) { return P.openSession(r.session.ref, acts); }));
      });
      acts.appendChild(cb);
    }
    if (d.config.wol_enabled && d.config.wol_mac_address) {
      var wb = el('button', { class: 'btn btn-sm', type: 'button', text: T('dev.wake') });
      wb.addEventListener('click', function () { busy(wb, P.api('POST', 'admin/devices/' + d.id + '/wake').then(function () { P.toast(T('dev.woken')); })); });
      acts.appendChild(wb);
    }
    if (!h) {
      var kb = el('button', { class: 'btn btn-sm', type: 'button', text: T('dev.check') });
      kb.addEventListener('click', function () { busy(kb, P.api('POST', 'admin/devices/' + d.id + '/check').then(load)); });
      acts.appendChild(kb);
    } else {
      acts.appendChild(el('button', { class: 'btn btn-sm', type: 'button', text: h.allowOpen ? T('dev.lock_open') : T('dev.allow_open'), on: { click: function (ev) {
        busy(ev.currentTarget, P.api('POST', 'admin/devices/' + d.id + '/allow-open', { allowOpen: !h.allowOpen }).then(load));
      } } }));
    }
    acts.appendChild(el('button', { class: 'btn btn-sm', type: 'button', text: T('dev.edit'), on: { click: function () {
      P.api('GET', 'admin/devices/' + d.id).then(function (r) { return editor(r.device); }).then(function (x) { if (x) load(); }).catch(P.warn);
    } } }));
    acts.appendChild(el('button', { class: 'btn btn-sm', type: 'button', text: d.enabled ? T('dev.disable') : T('dev.enable'), on: { click: function (ev) {
      busy(ev.currentTarget, P.api('POST', 'admin/devices/' + d.id + '/toggle').then(load));
    } } }));
    if (d.rotationDue) {
      acts.appendChild(el('button', { class: 'btn btn-sm', type: 'button', text: T('dev.rotated'), on: { click: function (ev) { busy(ev.currentTarget, P.api('POST', 'admin/devices/' + d.id + '/rotated').then(load)); } } }));
    }
    if (S.v3 && d.protocol === 'ssh' && d.config.ssh_engine === 'guac') {
      acts.appendChild(el('button', { class: 'btn btn-sm', type: 'button', text: T('dev.switch'), on: { click: function () { switchEngine([d.id], d.name); } } }));
    }
    acts.appendChild(el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: T('dev.delete'), on: { click: function () {
      P.confirmDialog(T('dev.delete_q', { name: d.name }), T('dev.delete')).then(function (ok) {
        if (!ok) return null;
        return P.api('DELETE', 'admin/devices/' + d.id).then(function () { P.toast(T('dev.deleted')); load(); });
      }).catch(P.warn);
    } } }));
    var badges = el('div', { class: 'rm-badges' }, [P.protoBadge(d.protocol), h && !h.registered ? el('span', { class: 'rm-badge', text: T('dev.unregistered') }) : P.stateBadge(d)]);
    if (h) {
      badges.appendChild(el('span', { class: 'rm-badge', text: T('dev.app_host') }));
      if (h.platform === 'android') badges.appendChild(el('span', { class: 'rm-badge', text: T('dev.phone') }));
      // 1.6: a Linux device of the agent
      if (h.platform === 'linux') badges.appendChild(el('span', { class: 'rm-badge', text: T('dev.linux') }));
      // 1.5: "Bildschirm teilen" of a PC
      if (h.platform === 'windows' && h.registered && h.screenView) badges.appendChild(el('span', { class: 'rm-badge', text: T('dev.pc_screen') }));
      if (h.registered && h.rdpEnabled === false && d.protocol === 'rdp' && h.rdpOffered !== false) badges.appendChild(el('span', { class: 'rm-badge', 'data-tone': 'warn', text: T('dev.rdp_off') }));
      badges.appendChild(el('span', { class: 'rm-badge', text: T(h.connect === 'open' ? 'dev.share_open' : 'dev.share_code') }));
      if (!h.allowOpen) badges.appendChild(el('span', { class: 'rm-badge', 'data-tone': 'warn', text: T('dev.open_locked') }));
    }
    if (d.rotationDue) badges.appendChild(el('span', { class: 'rm-badge', 'data-tone': 'warn', text: T('dev.rotation_due') }));
    if (d.credential && d.credential.readable === false) badges.appendChild(el('span', { class: 'rm-badge', 'data-tone': 'crit', text: T('dev.cred_unreadable') }));
    if (d.listenerError) badges.appendChild(el('span', { class: 'rm-badge', 'data-tone': 'crit', title: d.listenerError, text: T('dev.listener_error') }));
    if (d.activeSessions) badges.appendChild(el('span', { class: 'rm-badge', 'data-tone': 'good', text: T('dev.active', { n: d.activeSessions }) }));
    if (!d.config.browser_enabled) badges.appendChild(el('span', { class: 'rm-badge', text: T('dev.apps_only') }));
    if (d.protocol === 'ssh' && S.v3) {
      badges.appendChild(el('span', { class: 'rm-badge', 'data-tone': d.config.ssh_engine === 'term' ? 'good' : null, text: T(d.config.ssh_engine === 'term' ? 'dev.engine_term' : 'dev.engine_guac') }));
      if (d.config.ssh_engine === 'guac' && d.config.term_tested_at) badges.appendChild(el('span', { class: 'rm-badge', text: T('dev.term_tested') }));
    }
    if (d.config.recording === 'optional' || d.config.recording === 'always') badges.appendChild(el('span', { class: 'rm-badge', 'data-tone': d.config.recording === 'always' ? 'warn' : null, text: T('dev.rec_' + d.config.recording) }));
    var sub = [h && h.platform === 'android' ? T(h.screenControl ? 'dev.phone_addr_control' : 'dev.phone_addr')
      : (h && d.protocol === 'screen' ? T('dev.pc_screen_addr') : address(d))];
    if (h) {
      sub.push(T('dev.owner', { name: h.ownerName || '#' + h.owner }));
      if (h.osUser) sub.push(T('dev.os_user', { name: h.osUser }));
      if (h.platform === 'linux') {
        if (h.ssh && h.ssh.offered) sub.push(T('dev.linux_ssh', { name: h.ssh.user || '?' }) + (h.ssh.tmux ? ' · tmux ' + (h.ssh.tmuxVersion || '') : ' · ' + T('dev.linux_no_tmux')));
        if (h.desktop) sub.push(T('dev.linux_desktop', { kind: h.desktop.kind || '?', protocol: String(h.desktop.protocol || '').toUpperCase(), port: h.desktop.port }) + (h.desktop.ready ? '' : ' · ' + T('dev.linux_desktop_off')));
        if (h.hostKey) sub.push(T('dev.linux_hostkey', { alg: h.hostKey.alg || '' }));
      }
    }
    if (d.status && d.status.lastCheck) sub.push(T('dev.checked', { ago: P.ago(d.status.lastCheck) }) + (d.status.responseTime != null ? ' · ' + d.status.responseTime + ' ms' : ''));
    if (!d.access.open) sub.push(T('dev.restricted', { n: d.access.users.length + d.access.groups.length + d.access.tokens.length }));
    return el('div', { class: 'rm-item', 'data-device': String(d.id) }, [
      el('div', { class: 'rm-item-main' }, [
        el('div', { class: 'rm-item-title', text: d.name }),
        el('div', { class: 'rm-item-sub', text: sub.join(' · ') }),
        d.config.description ? el('div', { class: 'rm-item-sub', text: d.config.description }) : null,
      ]),
      badges,
      acts,
    ]);
  }

  function stats() {
    var box = P.clear($('#rm-stats'));
    var n = function (f) { return S.devices.filter(f).length; };
    [[T('stat.total'), S.devices.length], [T('state.online'), n(function (d) { return d.status.online === true; })], [T('state.offline'), n(function (d) { return d.status.online === false; })],
      [T('state.maintenance'), n(function (d) { return d.maintenance; })], [T('stat.rotation'), n(function (d) { return d.rotationDue; })],
      [T('stat.sessions'), S.devices.reduce(function (a, d) { return a + (d.activeSessions || 0); }, 0)]].forEach(function (x) {
      box.appendChild(el('div', { class: 'rm-stat' }, [el('b', { text: String(x[1]) }), el('span', { text: x[0] })]));
    });
  }

  function draw() {
    var q = $('#rm-search').value.trim().toLowerCase();
    var pr = $('#rm-proto').value;
    var st = $('#rm-state').value;
    var list = S.devices.filter(function (d) {
      if (pr && d.protocol !== pr) return false;
      if (st === 'online' && d.status.online !== true) return false;
      if (st === 'offline' && d.status.online !== false) return false;
      if (!q) return true;
      return [d.name, d.config.host, d.config.description, (d.config.tags || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    var box = P.clear($('#rm-devices'));
    list.forEach(function (d) { box.appendChild(row(d)); });
    $('#rm-none').hidden = S.devices.length > 0;
    $('#rm-switch-all').hidden = !(S.v3 && S.devices.some(function (d) { return d.protocol === 'ssh' && d.config.ssh_engine === 'guac'; }));
    stats();
  }

  function load() {
    return P.api('GET', 'admin/devices').then(function (r) {
      S.devices = r.devices || [];
      S.gateways = r.gateways || [];
      S.pools = r.pools || [];
      S.gwList = !!r.available;
      draw();
    }).catch(P.warn);
  }

  ['#rm-search', '#rm-proto', '#rm-state'].forEach(function (s) { $(s).addEventListener('input', draw); $(s).addEventListener('change', draw); });
  $('#rm-add').addEventListener('click', function () { editor(null).then(function (x) { if (x) load(); }); });
  $('#rm-switch-all').addEventListener('click', function () { switchEngine(null); });
  $('#rm-check').addEventListener('click', function () {
    var b = $('#rm-check');
    busy(b, P.api('POST', 'admin/devices/check').then(function (r) { S.devices = r.devices || []; draw(); P.toast(T('dev.checked_all')); }));
  });
  P.api('GET', 'admin/settings').then(function (r) {
    S.v3 = r.remote >= 3;
    if (S.devices.length) draw();
    var l = r.license;
    if (l && l.required && l.valid === false) { $('#rm-licence').textContent = T('lic.missing'); $('#rm-licence').hidden = false; }
    else if (l && l.state === 'expiring') { $('#rm-licence').textContent = T('lic.expiring'); $('#rm-licence').hidden = false; }
  }).catch(function () {});
  load();
})();
