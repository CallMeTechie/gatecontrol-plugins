/* Admin page "Geräte": every target with its state, connect, wake, check, and the editor with all settings of a target.
   1.1: the Windows PCs the app registered (owner, "Angemeldet von der App", nur mit Code / ohne Code, "„Ohne Code“ sperren").
   1.2: SSH in GateControl's terminal (tmux, host key, a key made in GateControl, switching old Guacamole devices), recording.
   1.8: cards or table (rm.devices.view), search, filters and sorting, icon buttons with tooltips, the menu ⋮, on phones a
   list with a sheet; the large dialog for adding and editing (sections on the left, „Anmeldung“ and „Agent“), the key set-up
   (ui/keys.js), codes for the agent (ui/agent.js) with placeholders in the list, the tmux list before connecting. */
(function () {
  'use strict';
  var P = window.RM;
  var T = P.T, el = P.el, $ = P.$;
  var S = { devices: [], gateways: [], pools: [], gwList: false, v3: false, wizard: false, features: {}, enroll: [], loaded: false };

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
  function sshInfo(dev, username, hostOnly) {
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
      if (!hostOnly) acts.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: x.publicKey ? T('f.key_renew') : T('f.key_make'), on: { click: function (ev) {
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
      if (x.publicKey && !hostOnly) {
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

  /**
   * The fields of a device (the settings of the former Remote Desktops): an input per field, its row, the values, which
   * rows show, and the body for the API. The old editor puts the rows on tabs, the editor of one page (1.7) into sections.
   */
  function fieldSet(dev) {
    var v = dev ? Object.assign({ name: dev.name, protocol: dev.protocol, enabled: dev.enabled }, dev.config) : { name: '', protocol: 'rdp', enabled: true, port: 3389, access_mode: 'internal', credential_mode: 'full', resolution_mode: 'fullscreen', color_depth: 32, redirect_clipboard: true, audio_mode: 'local', network_profile: 'auto', nla_enabled: true, health_check_enabled: true, tags: [], ssh_engine: 'term', tmux_enabled: true, recording: 'off', browser_enabled: true };
    var cred = dev ? dev.credential : { set: false, has: {}, readable: true };
    var F = { inputs: {}, rows: {}, onChange: [] };
    F.values = function () {
      var out = {};
      Object.keys(F.inputs).forEach(function (k) {
        var n = F.inputs[k];
        var f = n._f;
        if (f.type === 'check') out[k] = n.checked;
        else if (f.type === 'number') out[k] = n.value === '' ? null : parseInt(n.value, 10);
        else if (f.type === 'select') out[k] = /^\d+$/.test(n.value) && k === 'color_depth' ? parseInt(n.value, 10) : n.value;
        else out[k] = n.value;
      });
      return out;
    };
    F.refresh = function () {
      var cur = F.values();
      TABS.forEach(function (tab) { tab.fields.forEach(function (f) { if (F.rows[f.key]) F.rows[f.key].hidden = !!(f.show && !f.show(cur)); }); });
      F.onChange.forEach(function (fn) { fn(cur); });
    };
    TABS.forEach(function (tab) {
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
          row = sshInfo(dev, function () { return F.inputs.username ? F.inputs.username.value : ''; });
        } else {
          var input = f.type === 'gateway' ? gatewayInput(id) : fieldInput(f, id);
          input._f = f;
          F.inputs[f.key] = input;
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
          input.addEventListener('change', F.refresh);
          if (f.key === 'protocol') input.addEventListener('change', function () { if (!dev) F.inputs.port.value = String({ rdp: 3389, vnc: 5900, ssh: 22, telnet: 23 }[input.value] || 3389); });
        }
        if (f.wide) row.classList.add('rm-wide-field');
        F.rows[f.key] = row;
      });
    });
    F.collect = function () {
      var cur = F.values();
      var config = {};
      Object.keys(cur).forEach(function (k) {
        var f = F.inputs[k]._f;
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
      else CRED_KEYS.forEach(function (k) { if (F.inputs[k] && cur[k] !== '') c[k] = cur[k]; });
      if (Object.keys(c).length) out.credentials = c;
      return out;
    };
    /** set a value from outside (the target of the wizard) */
    F.set = function (k, val) {
      var n = F.inputs[k];
      if (!n) return;
      if (n._f.type === 'check') n.checked = !!val;
      else if (n._f.type === 'gateway') n.value = val || '';
      else n.value = val == null ? '' : String(val);
    };
    return F;
  }

  /** The text of an API error with the field it names. */
  function saveError(e) {
    var d = (e && e.data) || {};
    return P.errText(e) + (d.field ? ' (' + T('f.' + d.field.replace(/^credentials\./, '')) + ')' : '') + (d.suggestedPort ? ' ' + T('f.suggested_port', { port: d.suggestedPort }) : '');
  }

  // ─── 1.8: the large dialog with a list of sections on the left (adding and editing) ───
  /**
   * sections: [{ id, label, node, small?, tone? }] → { dlg, select(id), mark(id, text, tone), show(id, on), current() }
   * The list is a vertical tab list; on narrow frames it becomes a row that scrolls (CSS).
   */
  function sectionDialog(o) {
    var dlg = P.bigDialog({ title: o.title, sub: o.sub, label: o.label || o.title, size: 'xl', onClose: o.onClose });
    var nav = el('div', { class: 'rm-snav', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': T('ed.sections') });
    var panes = el('div', { class: 'rm-spanes' });
    var btns = {};
    var panels = {};
    var cur = null;
    o.sections.forEach(function (s) {
      var small = el('small', { text: s.small || '' });
      btns[s.id] = el('button', { type: 'button', role: 'tab', id: 'rm-sn-' + s.id, class: 'rm-sni', 'aria-selected': 'false', 'aria-controls': 'rm-sp-' + s.id, on: { click: function () { api2.select(s.id); } } },
        [el('span', { text: s.label }), small]);
      btns[s.id]._small = small;
      nav.appendChild(btns[s.id]);
      panels[s.id] = el('div', { role: 'tabpanel', id: 'rm-sp-' + s.id, class: 'rm-spane', 'aria-labelledby': 'rm-sn-' + s.id, hidden: true }, [el('h3', { class: 'rm-spane-title', text: s.label }), s.node]);
      panes.appendChild(panels[s.id]);
    });
    nav.addEventListener('keydown', function (ev) {
      var ids = Object.keys(btns).filter(function (k) { return !btns[k].hidden; });
      var i = ids.indexOf(cur);
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') { ev.preventDefault(); api2.select(ids[(i + 1) % ids.length], true); }
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') { ev.preventDefault(); api2.select(ids[(i - 1 + ids.length) % ids.length], true); }
    });
    dlg.body.classList.add('rm-cols', 'nav');
    dlg.body.appendChild(nav);
    dlg.body.appendChild(panes);
    var api2 = {
      dlg: dlg,
      select: function (id, focus) {
        if (!panels[id]) return;
        cur = id;
        Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== id; btns[k].setAttribute('aria-selected', k === id ? 'true' : 'false'); btns[k].tabIndex = k === id ? 0 : -1; });
        panes.scrollTop = 0;
        if (focus) btns[id].focus();
        if (o.onSelect) o.onSelect(id);
      },
      mark: function (id, text, tone) { if (!btns[id]) return; btns[id]._small.textContent = text || ''; btns[id]._small.className = tone || ''; },
      show: function (id, on) { if (!btns[id]) return; btns[id].hidden = !on; if (!on && cur === id) api2.select(o.sections[0].id); },
      current: function () { return cur; },
    };
    api2.select(o.start && panels[o.start] ? o.start : o.sections[0].id);
    return api2;
  }

  function stateTagOf(dev) {
    var st = dev.status || {};
    if (dev.enabled === false) return el('span', { class: 'rmx-tag', text: T('state.disabled') });
    if (st.online === true) return el('span', { class: 'rmx-tag ok', text: T('state.online') + (st.responseTime != null ? ' · ' + st.responseTime + ' ms' : '') });
    if (st.online === false) return el('span', { class: 'rmx-tag err', text: T('state.offline') });
    return null;
  }

  /** The editor with tabs (a PC, phone or Linux device of an app; GateControl before version 7) in the large dialog. */
  function editor(dev) {
    var F = fieldSet(dev);
    var errBox = el('p', { class: 'rm-field-error', role: 'alert', hidden: true });
    var sections = [];
    var top = el('div', { class: 'rm-grid' });
    TABS.forEach(function (tab) {
      var grid = el('div', { class: 'rm-grid' });
      tab.fields.forEach(function (f) { (f.top ? top : grid).appendChild(F.rows[f.key]); });
      sections.push({ id: tab.id, label: T('tab.' + tab.id), node: tab.id === 'connection' ? el('div', null, [top, grid, dev && dev.source === 'import' ? el('p', { class: 'rm-hint', text: T('dev.imported_hint') }) : null]) : grid });
    });
    var result;
    var done = new Promise(function (r) { result = r; });
    var SD = sectionDialog({ title: dev ? dev.name : T('dev.add'), sub: dev ? subOf(dev) : null, label: dev ? T('dev.edit_name', { name: dev.name }) : T('dev.add'), sections: sections,
      onClose: function (v) { result(v || null); } });
    var dlg = SD.dlg;
    var tag = dev ? stateTagOf(dev) : null;
    if (tag) dlg.tools.appendChild(tag);
    F.onChange.push(function (cur) { TABS.forEach(function (tab) { SD.show(tab.id, !tab.show || tab.show(cur)); }); });
    F.refresh();
    function tabOf(key) {
      var hit = null;
      TABS.forEach(function (t) { t.fields.forEach(function (f) { if (f.key === key || (f.key === 'gateway' && /^gateway_(peer|pool)_id$/.test(key))) hit = t.id; }); });
      return hit;
    }
    var save = el('button', { type: 'button', class: 'btn btn-primary', text: T('common.save') });
    save.addEventListener('click', function () {
      save.disabled = true;
      errBox.hidden = true;
      TABS.forEach(function (t) { SD.mark(t.id, ''); });
      P.api(dev ? 'PUT' : 'POST', 'admin/devices' + (dev ? '/' + dev.id : ''), F.collect()).then(function (r) { P.toast(T('common.saved')); dlg.close(r.device); }).catch(function (e) {
        save.disabled = false;
        var d = (e && e.data) || {};
        errBox.textContent = saveError(e);
        errBox.hidden = false;
        var t = d.field && tabOf(d.field.replace(/^credentials\./, ''));
        if (t) { SD.mark(t, T('ed.error'), 'bad'); SD.select(t); }
      });
    });
    dlg.foot.appendChild(errBox);
    if (dev) dlg.foot.appendChild(el('button', { type: 'button', class: 'btn rmx-ghost rm-red', text: T('dev.delete'), on: { click: function () { removeDevice(dev).then(function (ok) { if (ok) dlg.close(true); }); } } }));
    dlg.foot.appendChild(el('span', { class: 'rmx-sp' }));
    dlg.foot.appendChild(el('button', { type: 'button', class: 'btn rmx-ghost', text: T('common.cancel'), on: { click: function () { dlg.close(null); } } }));
    dlg.foot.appendChild(save);
    setTimeout(function () { try { F.inputs.name.focus(); } catch (e) { /* gone */ } }, 0);
    return done;
  }

  // ─── 1.7 / 1.8: the editor of a device made here, in sections (GateControl with gc.remote version 7) ───
  var WAY_KEYS = ['name', 'protocol', 'enabled', 'host', 'port', 'access_mode', 'external_hostname', 'external_port', 'gateway', 'gateway_listen_port', 'health_check_enabled'];
  var SECTIONS = [
    { id: 'way' },
    { id: 'auth', keys: ['username', 'password', 'privateKey', 'passphrase', 'credential_mode', 'domain', 'cred_state', 'cred_clear'] },
    { id: 'agent', show: function (v) { return v.protocol === 'ssh'; } },
    { id: 'terminal', show: function (v) { return v.protocol === 'ssh'; }, keys: ['ssh_engine', 'tmux_enabled', 'tmux_name'] },
    { id: 'access' },
    { id: 'wol', keys: ['wol_enabled', 'wol_mac_address', 'maintenance_enabled', 'maintenance_schedule', 'credential_rotation_enabled', 'credential_rotation_days'] },
    { id: 'display', show: function (v) { return v.protocol === 'rdp' || v.protocol === 'vnc'; }, keys: ['resolution_mode', 'resolution_width', 'resolution_height', 'color_depth', 'multi_monitor',
      'redirect_clipboard', 'redirect_printers', 'redirect_drives', 'redirect_usb', 'redirect_smartcard', 'audio_mode', 'network_profile', 'bandwidth_limit', 'nla_enabled',
      'disable_wallpaper', 'disable_themes', 'disable_animations', 'session_timeout', 'admin_session', 'remote_app', 'start_program', 'gateway_host', 'gateway_port'] },
    { id: 'browser', keys: ['browser_enabled', 'browser_clipboard', 'rdp_disable_audio', 'recording', 'rec_always_note'] },
    { id: 'notes', keys: ['description', 'tags', 'notes'] },
  ];

  function gwName(c) {
    var g = S.gateways.filter(function (x) { return x.peerId === c.gateway_peer_id; })[0];
    var p = S.pools.filter(function (x) { return x.poolId === c.gateway_pool_id; })[0];
    return g ? g.name : (p ? p.name : '#' + (c.gateway_peer_id || c.gateway_pool_id || '?'));
  }
  /** The way of the values in the editor as one line (from the stored way while nothing changed). */
  function wayLine(cur, w, changed) {
    if (cur.access_mode === 'gateway') return T(cur.gateway && /^pool:/.test(cur.gateway) ? 'ed.via_pool' : 'ed.via_gateway', { name: gwName(gwConfig(cur)) });
    if (cur.access_mode === 'external') return T('ed.via_internet');
    if (!changed && w && w.kind === 'vpn') return w.peer ? T('ed.in_vpn_name', { name: w.peer.name }) : T('ed.in_vpn');
    if (!changed && w && w.kind === 'internet') return T('ed.via_internet');
    if (!changed && w && w.kind === 'server') return T('ed.in_server');
    return T('ed.direct');
  }
  function gwConfig(cur) {
    var g = String(cur.gateway || '');
    var mp = /^peer:(\d+)$/.exec(g);
    var ml = /^pool:(\d+)$/.exec(g);
    return { gateway_peer_id: mp ? parseInt(mp[1], 10) : (/^\d+$/.test(g) ? parseInt(g, 10) : null), gateway_pool_id: ml ? parseInt(ml[1], 10) : null };
  }

  /** „appserver“ · 192.168.2.50:22 · über Gateway „Zuhause“ · SSH */
  function subOf(d) {
    var w = wayOf(d);
    return [address(d), w.text, T('proto.' + d.protocol)].filter(Boolean).join(' · ');
  }

  /** 1.8: the section „Anmeldung“ — the refused login, the way to sign in, GateControl's key and its set-up. */
  function authPanel(dev, F, SD) {
    var box = el('div', { class: 'rm-auth' });
    var ssh = function () { return F.values().protocol === 'ssh'; };
    var mode = dev.auth === 'gc_key' ? 'gc' : (dev.auth === 'own_key' ? 'own' : 'password');
    if (dev.auth === 'failed' && dev.lastAuthFailed) {
      var f = dev.lastAuthFailed;
      box.appendChild(el('div', { class: 'rmx-note err', role: 'status' }, [P.icon('warn', 18), el('div', null, [el('b', { text: T('ed.auth_failed_head') }),
        el('span', { class: 'rmx-small', text: f.username ? T('ed.auth_failed_text', { when: P.when(f.at), user: f.username }) : T('ed.auth_failed_text2', { when: P.when(f.at) }) })])]));
    }
    box.appendChild(el('div', { class: 'rm-grid' }, [F.rows.username]));
    var radio = el('div', { class: 'rmx-radio', role: 'radiogroup', 'aria-label': T('ed.login_with') });
    var pwBox = el('div', { class: 'rm-grid' }, [F.rows.password]);
    var gcBox = el('div', { class: 'rm-keyst' });
    var ownBox = el('div', { class: 'rm-grid' }, [F.rows.privateKey, F.rows.passphrase]);
    var keyHint = el('div');
    var rdpBox = el('div', { class: 'rm-grid' }, [F.rows.credential_mode, F.rows.domain]);
    function drawRadio() {
      P.clear(radio);
      [['password', T('f.password'), T('ed.pw_sub')], ['gc', T('wz.key_gc'), T('ed.gc_sub')], ['own', T('wz.key_own'), T('wz.key_own_text')]].forEach(function (x) {
        radio.appendChild(el('button', { type: 'button', class: 'rmx-ropt', role: 'radio', 'aria-checked': mode === x[0] ? 'true' : 'false', 'aria-pressed': mode === x[0] ? 'true' : 'false',
          on: { click: function () { mode = x[0]; drawMode(); } } }, [el('span', { class: 'dot' }), el('div', null, [el('b', { text: x[1] }), el('span', { text: x[2] })])]));
      });
    }
    function keyStatus() {
      P.clear(gcBox);
      var k = dev.key;
      var has = dev.auth === 'gc_key' || (dev.ssh && dev.ssh.publicKey);
      if (!has) {
        gcBox.appendChild(el('p', { class: 'rmx-small', text: T('ed.gc_none') }));
        var acts0 = el('div', { class: 'acts' });
        if (S.features.keySetup && dev.kind === 'target') acts0.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-primary', on: { click: function () { keySetup(dev, SD); } } }, [P.icon('key'), T('act.key_setup')]));
        acts0.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('f.key_make'), on: { click: function (ev) {
          var b = ev.currentTarget;
          b.disabled = true;
          P.api('POST', 'admin/devices/' + dev.id + '/key', { username: F.inputs.username.value || undefined }).then(function (r) { dev.ssh = r.device.ssh; dev.auth = r.device.auth; P.toast(T('f.key_made')); keyStatus(); })
            .catch(P.warn).then(function () { b.disabled = false; });
        } } }));
        gcBox.appendChild(acts0);
        return;
      }
      var kv = el('div', { class: 'rmx-kv rm-kv-left' });
      var add = function (a, b, mono) { kv.appendChild(el('span', { text: a })); kv.appendChild(el('b', { class: mono ? 'mono' : null, text: b })); };
      add(T('ed.k_status'), T(k && k.auto ? 'ed.k_auto' : 'ed.k_manual'));
      if (k && k.fingerprint) add(T('ed.k_fp'), String(k.fingerprint.alg || '').replace(/^ssh-/, '').toUpperCase() + ' SHA256:' + k.fingerprint.sha256, true);
      if (k && k.path) add(T('ed.k_path'), k.path, true);
      if (k) add(T('ed.k_from'), k.from && k.from.length ? k.from.join(', ') : T('key.from_any'));
      if (k && k.installedAt) add(T('ed.k_when'), T('ed.k_when_v', { when: P.when(k.installedAt), name: k.installedByName || '–' }));
      gcBox.appendChild(kv);
      var acts = el('div', { class: 'acts' });
      if (dev.ssh && (dev.ssh.line || dev.ssh.publicKey)) {
        var cp = el('button', { type: 'button', class: 'btn btn-sm' }, [P.icon('copy'), T('ed.k_copy')]);
        cp.addEventListener('click', function () { P.copy(dev.ssh.line || dev.ssh.publicKey, cp); });
        acts.appendChild(cp);
      }
      if (S.features.keySetup && dev.kind === 'target') {
        acts.appendChild(el('button', { type: 'button', class: 'btn btn-sm', on: { click: function () { keySetup(dev, SD); } } }, [P.icon('renew'), T('ed.k_again')]));
        acts.appendChild(el('button', { type: 'button', class: 'btn btn-sm btn-danger', on: { click: function (ev) { removeKey(dev, ev.currentTarget).then(function (d2) { if (d2) { dev.key = d2.key; dev.auth = d2.auth; dev.ssh = d2.ssh; mode = 'password'; drawMode(); } }); } } }, [P.icon('trash'), T('ed.k_remove')]));
      }
      gcBox.appendChild(acts);
      if (S.features.keySetup) gcBox.appendChild(el('p', { class: 'rmx-small', text: T('ed.k_remove_hint', { id: dev.id }) }));
    }
    function drawMode() {
      var isSsh = ssh();
      radio.hidden = !isSsh;
      drawRadio();
      pwBox.hidden = isSsh && mode !== 'password';
      ownBox.hidden = !isSsh || mode !== 'own';
      gcBox.hidden = !isSsh || mode !== 'gc';
      rdpBox.hidden = isSsh;
      if (isSsh && mode === 'gc') keyStatus();
      P.clear(keyHint);
      if (isSsh && mode === 'password' && dev.kind === 'target') {
        if (S.features.keySetup) {
          keyHint.appendChild(el('div', { class: 'rmx-note info rm-keybox' }, [P.icon('key', 18), el('div', null, [el('b', { text: T('ed.key_instead') }), el('span', { class: 'rmx-small', text: T('ed.key_instead_text') }),
            el('div', { class: 'acts' }, [el('button', { type: 'button', class: 'btn btn-sm btn-primary', on: { click: function () { keySetup(dev, SD); } } }, [P.icon('key'), T('act.key_setup')])])])]));
        }
        keyHint.appendChild(el('p', { class: 'rmx-small' }, [T('ed.agent_instead') + ' ', el('button', { type: 'button', class: 'rmx-lnk', text: T('ed.sec_agent'), on: { click: function () { SD.select('agent'); } } })]));
      }
    }
    box.appendChild(el('span', { class: 'rmx-flabel', text: T('ed.login_with') }));
    box.appendChild(radio);
    box.appendChild(pwBox);
    box.appendChild(gcBox);
    box.appendChild(ownBox);
    box.appendChild(keyHint);
    box.appendChild(rdpBox);
    box.appendChild(el('div', { class: 'rm-grid' }, [F.rows.cred_state, F.rows.cred_clear]));
    F.onChange.push(function () { drawMode(); });
    drawMode();
    return box;
  }

  /** 1.8: the section „Agent“ — a code that takes this device over (or the way through the user without version 9). */
  function agentPanel(dev) {
    var box = el('div', { class: 'rm-agentsec' });
    var started = false;
    var ctl = null;
    return {
      node: box,
      start: function () {
        if (started) return;
        started = true;
        if (!S.features.enroll) { window.RMA.fallback(box, dev.name); return; }
        var en = S.enroll.filter(function (e) { return e.adoptDeviceId === dev.id; })[0] || null;
        var go = function (full) {
          ctl = window.RMA.panel(box, { adopt: dev, enrollment: full, me: S.me, name: dev.name, user: (dev.key && dev.key.account !== 'root' && dev.key.account) || '',
            onRegistered: function () { P.toast(T('ag.adopted', { name: dev.name })); load(); } });
        };
        if (en) P.api('GET', 'admin/enroll/' + encodeURIComponent(en.ticket)).then(function (r) { go(r.enrollment); }).catch(function () { go(null); });
        else go(null);
      },
      stop: function () { if (ctl) ctl.stop(); },
    };
  }

  function editOne(dev, start) {
    var F = fieldSet(dev);
    var w = dev.wayDetail || null;
    var changed = false;
    var errBox = el('p', { class: 'rm-field-error', role: 'alert', hidden: true });
    var cardName = el('span', { class: 'rmx-rname' });
    var cardSub = el('span', { class: 'rmx-rsub' });
    var people = null;
    var SD = null;

    function accessText() {
      var a = dev.access || { users: [], groups: [], tokens: [] };
      if (a.open) return T('ed.access_open');
      var names = [];
      var adminsOnly = !a.groups.length && !a.tokens.length;
      a.users.forEach(function (id) {
        var p = people && people.people ? people.people.filter(function (x) { return x.id === id; })[0] : null;
        if (!p || p.role !== 'admin') adminsOnly = false;
        names.push(p ? p.name : '#' + id);
      });
      a.groups.forEach(function (id) {
        var g = people && people.groups ? people.groups.filter(function (x) { return x.id === id; })[0] : null;
        names.push(g ? g.path : '#' + id);
      });
      if (a.tokens.length) names.push(T('ed.tokens', { n: a.tokens.length }));
      return people && adminsOnly ? T('wz.admins_only') : names.join(', ');
    }
    function accessCount() {
      var a = dev.access || { users: [], groups: [], tokens: [] };
      if (a.open) return T('ed.access_open_short');
      var adminsOnly = !!(people && people.people) && !a.groups.length && !a.tokens.length && a.users.every(function (id) {
        return people.people.some(function (x) { return x.id === id && x.role === 'admin'; });
      });
      return adminsOnly ? T('wz.admins_only') : T('ed.persons', { n: a.users.length + a.groups.length + a.tokens.length });
    }
    function summary(id, cur) {
      if (id === 'access') { var ac = accessCount(); return ac.length > 12 ? null : ac; }
      if (id === 'auth') return dev.auth === 'failed' ? T('ed.error') : (cur.protocol === 'ssh' ? T('auth.' + (dev.auth || 'password')) : null);
      if (id === 'agent') return S.enroll.some(function (e) { return e.adoptDeviceId === dev.id; }) ? T('ag.waiting') : T('ed.new');
      if (id === 'wol') return cur.wol_enabled ? T('ed.wol_on') : (cur.maintenance_enabled ? T('ed.maint_on') : null);
      if (id === 'display') return T('res.' + cur.resolution_mode);
      if (id === 'browser') return cur.recording && cur.recording !== 'off' ? T('rec.' + cur.recording) : null;
      if (id === 'terminal') return cur.ssh_engine === 'term' && cur.tmux_enabled ? 'tmux' : T(cur.ssh_engine === 'term' ? 'dev.engine_term' : 'dev.engine_guac');
      if (id === 'way') return null;
      return cur.tags ? (String(cur.tags).split(',').filter(function (x) { return x.trim(); }).length ? String(cur.tags).split(',').length + '' : null) : null;
    }
    function drawCard(cur) {
      cardName.textContent = (cur.host || '–') + ' · ' + T('proto.' + cur.protocol) + ' ' + (cur.port || '');
      var sub = [wayLine(cur, w, changed)];
      if (dev.source === 'import') sub.push(T('ed.imported'));
      cardSub.textContent = sub.join(' · ');
    }
    var kv = el('div', { class: 'rmx-kv' });
    var kvNote = el('p', { class: 'rmx-small' });
    function drawKv(cur) {
      P.clear(kv);
      var listen = cur.access_mode === 'gateway'
        ? (cur.gateway_listen_port ? String(cur.gateway_listen_port) + (dev.source === 'import' && !changed ? ' ' + T('ed.kept') : '') : T('wz.listen_auto'))
        : T('wz.none');
      var apps = cur.access_mode === 'gateway' ? T('wz.apps_server')
        : (cur.access_mode === 'external' || cur.access_mode === 'both' ? (cur.external_hostname || '–') + ':' + (cur.external_port || cur.port) : T('wz.apps_direct_vpn'));
      [[T('wz.kv_way'), wayLine(cur, w, changed) + (cur.access_mode === 'gateway' ? ' ' + T('ed.automatic') : '')], [T('f.gateway_listen_port'), listen], [T('wz.kv_apps'), apps]].forEach(function (x) {
        kv.appendChild(el('span', { text: x[0] }));
        kv.appendChild(el('b', { text: x[1] }));
      });
      kvNote.textContent = dev.source === 'import' && dev.config.access_mode === 'gateway' && !changed ? T('ed.kept_note') : T('ed.way_text');
    }
    var hintBox = el('div');
    function drawHint() {
      P.clear(hintBox);
      var h = w && w.hint && !changed ? w.hint : null;
      if (!h || h.kind !== 'lan' || !h.gateway) return;
      var g = h.gateway;
      hintBox.appendChild(el('div', { class: 'rmx-note warn', role: 'status' }, [P.icon('warn', 18), el('div', null, [
        el('b', { text: T('ed.lan_hint', { name: g.name }) }), el('span', { class: 'rmx-small', text: T('ed.lan_hint_text') }),
        el('div', { class: 'acts' }, [el('button', { type: 'button', class: 'btn btn-sm', text: T('ed.lan_use'), on: { click: function () {
          F.set('access_mode', 'gateway');
          F.set('gateway', g.pool ? 'pool:' + g.pool.poolId : 'peer:' + g.peerId);
          F.set('gateway_listen_port', '');
          changed = true;
          F.refresh();
          drawHint();
        } } })]),
      ])]));
    }
    var result;
    var done = new Promise(function (r) { result = r; });
    var retarget = el('button', { type: 'button', class: 'btn btn-sm rmx-ghost', text: T('ed.retarget'), on: { click: function () {
      window.RMW.open({ device: Object.assign({}, dev, { config: Object.assign({}, dev.config, F.collect().config) }) }).then(function (x) {
        if (!x) return;
        if (x.open) { SD.dlg.close(null); openEditor(x.open); return; }
        if (!x.target) return;
        var c = x.target.config;
        ['host', 'port', 'access_mode', 'external_hostname', 'external_port', 'gateway_listen_port'].forEach(function (k) { F.set(k, c[k]); });
        F.set('gateway', c.gateway_pool_id ? 'pool:' + c.gateway_pool_id : (c.gateway_peer_id ? 'peer:' + c.gateway_peer_id : ''));
        F.set('protocol', x.target.protocol);
        changed = true;
        F.refresh();
        drawHint();
      });
    } } });
    var c0 = dev.config;
    var targetCard = el('div', { class: 'rmx-target' }, [window.RMW.ico(c0.access_mode === 'gateway' ? 'lan' : (w && w.kind === 'vpn' ? 'vpn' : (w && w.kind === 'internet' ? 'ext' : 'lan')),
      dev.protocol === 'rdp' ? 'pc' : (dev.protocol === 'ssh' ? 'server' : 'laptop')), el('span', { class: 'rmx-rmain' }, [cardName, cardSub]), retarget]);
    // the sections
    var nodes = {};
    var wayGrid = el('div', { class: 'rm-grid' });
    WAY_KEYS.forEach(function (k) { if (F.rows[k]) wayGrid.appendChild(F.rows[k]); });
    nodes.way = el('div', { class: 'rm-sec' }, [targetCard, hintBox, wayGrid, el('details', { class: 'rmx-adv' }, [el('summary', { text: T('wz.advanced') }), el('div', { class: 'advb' }, [kv, kvNote])]),
      dev.source === 'import' ? el('p', { class: 'rm-hint', text: T('dev.imported_hint') }) : null]);
    var ag = agentPanel(dev);
    nodes.agent = ag.node;
    nodes.terminal = el('div', { class: 'rm-sec' }, [el('div', { class: 'rm-grid' }, ['ssh_engine', 'tmux_enabled', 'tmux_name'].map(function (k) { return F.rows[k]; })),
      sshInfo(dev, function () { return F.inputs.username ? F.inputs.username.value : ''; }, true)]);
    var line = el('div');
    var pickAccess = function () {
      if (!window.GC || typeof window.GC.pickPrincipals !== 'function') { P.toast(T('wz.no_picker'), 'error'); return; }
      window.GC.pickPrincipals({ groups: true, users: true, multiple: true, title: T('wz.share_title', { name: dev.name }) }).then(function (picked) {
        if (!picked) return null;
        return P.api('PUT', 'admin/devices/' + dev.id + '/access', {
          users: picked.filter(function (x) { return x.type === 'user'; }).map(function (x) { return x.id; }),
          groups: picked.filter(function (x) { return x.type === 'group'; }).map(function (x) { return x.id; }),
        }).then(function (r) { dev.access = r.device.access; drawAccess(); F.refresh(); });
      }).catch(P.warn);
    };
    var drawAccess = function () {
      P.clear(line);
      line.appendChild(document.createTextNode(accessText() + ' · '));
      line.appendChild(el('button', { type: 'button', class: 'rmx-lnk', text: T('ed.change'), on: { click: pickAccess } }));
    };
    drawAccess();
    P.api('GET', 'admin/rights').then(function (r) { people = r; drawAccess(); F.refresh(); }).catch(function () {});
    nodes.access = el('div', { class: 'rm-sec' }, [line, el('p', { class: 'rmx-small', text: T('ed.access_hint') })]);
    SECTIONS.forEach(function (sec) {
      if (nodes[sec.id] || sec.id === 'auth') return;
      var grid = el('div', { class: 'rm-grid' });
      sec.keys.forEach(function (k) { if (F.rows[k]) grid.appendChild(F.rows[k]); });
      nodes[sec.id] = grid;
    });
    nodes.auth = el('div');
    SD = sectionDialog({ title: dev.name, sub: subOf(dev), label: T('dev.edit_name', { name: dev.name }), start: start || 'way',
      sections: SECTIONS.map(function (sec) { return { id: sec.id, label: T('ed.sec_' + sec.id), node: nodes[sec.id] }; }),
      onSelect: function (id) { if (id === 'agent') ag.start(); },
      onClose: function (v) { ag.stop(); result(v || null); } });
    nodes.auth.appendChild(authPanel(dev, F, SD));
    if (SD.current() === 'agent') ag.start();
    var dlg = SD.dlg;
    var tag = stateTagOf(dev);
    if (tag) dlg.tools.appendChild(tag);
    F.onChange.push(function (cur) {
      SECTIONS.forEach(function (sec) {
        SD.show(sec.id, !(sec.show && !sec.show(cur)) && !(sec.id === 'agent' && dev.kind !== 'target'));
        if (sec.id === 'auth' && dev.auth === 'failed') SD.mark('auth', T('ed.error'), 'bad');
        else SD.mark(sec.id, summary(sec.id, cur) || '', sec.id === 'agent' ? 'new' : '');
      });
      drawCard(cur);
      drawKv(cur);
    });
    F.refresh();
    drawHint();
    var save = el('button', { type: 'button', class: 'btn btn-primary', text: T('common.save') });
    save.addEventListener('click', function () {
      save.disabled = true;
      errBox.hidden = true;
      P.api('PUT', 'admin/devices/' + dev.id, F.collect()).then(function (r) { P.toast(T('common.saved')); dlg.close(r.device); }).catch(function (e) {
        save.disabled = false;
        errBox.textContent = saveError(e);
        errBox.hidden = false;
        var d = (e && e.data) || {};
        var key = d.field ? String(d.field).replace(/^credentials\./, '').replace(/^gateway_(peer|pool)_id$/, 'gateway') : null;
        var hit = WAY_KEYS.indexOf(key) >= 0 ? 'way' : null;
        SECTIONS.forEach(function (sec) { if (key && sec.keys && sec.keys.indexOf(key) >= 0) hit = sec.id; });
        if (hit) { SD.mark(hit, T('ed.error'), 'bad'); SD.select(hit); }
      });
    });
    dlg.foot.appendChild(errBox);
    dlg.foot.appendChild(el('button', { type: 'button', class: 'btn rmx-ghost rm-red', text: T('dev.delete'), on: { click: function () { removeDevice(dev).then(function (ok) { if (ok) dlg.close(true); }); } } }));
    dlg.foot.appendChild(el('span', { class: 'rmx-sp' }));
    dlg.foot.appendChild(el('button', { type: 'button', class: 'btn rmx-ghost', text: T('common.cancel'), on: { click: function () { dlg.close(null); } } }));
    dlg.foot.appendChild(save);
    return done;
  }

  /** Edit a device: the editor in sections with version 7 (a target), else the editor with tabs. start: a section. */
  function openEditor(id, start) {
    return P.api('GET', 'admin/devices/' + id).then(function (r) {
      return S.wizard && r.device.kind !== 'host' && window.RMW ? editOne(r.device, start) : editor(r.device);
    }).then(function (x) { if (x) load(); }).catch(P.warn);
  }

  /** Add a device: the wizard with version 7, else the old form. */
  function addDevice() {
    if (!(S.wizard && window.RMW)) return editor(null).then(function (x) { if (x) load(); });
    return window.RMW.open({ features: S.features, me: S.me, devices: S.devices }).then(function (x) {
      return load().then(function () {
        if (x && x.open) openEditor(x.open, x.section);
        var c = x && x.connectId ? S.devices.filter(function (d) { return d.id === x.connectId; })[0] : null;
        if (c) connectFlow(c);
      });
    });
  }

  // ─── 1.8: what a device needs: key set-up, removing the key, connecting with tmux ───
  function keySetup(d, SD) {
    if (!window.RMK) return Promise.resolve(null);
    return P.api('GET', 'admin/devices/' + d.id).then(function (r) {
      return window.RMK.open(r.device, {
        onAgent: function (x) { if (SD) SD.select('agent'); else openEditor(x.id, 'agent'); },
        connect: function (x) { connectFlow(x); },
      });
    }).then(function (x) {
      if (x && SD) { SD.dlg.close(null); openEditor(d.id, 'auth'); }
      load();
      return x;
    }).catch(P.warn);
  }
  function removeKey(d, b) {
    return P.confirmDialog(T('ed.k_remove_q', { name: d.name, id: d.id }), T('ed.k_remove')).then(function (ok) {
      if (!ok) return null;
      if (b) b.disabled = true;
      return P.api('DELETE', 'admin/devices/' + d.id + '/key').then(function (r) {
        P.toast(r.removedRemote ? T('ed.k_removed') : T('ed.k_removed_vault', { comment: r.comment || '' }), r.removedRemote ? 'good' : 'error');
        load();
        return r.device;
      });
    }).catch(P.warn).then(function (x) { if (b) b.disabled = false; return x; });
  }
  function removeDevice(d) {
    return P.confirmDialog(T('dev.delete_q', { name: d.name }), T('dev.delete')).then(function (ok) {
      if (!ok) return false;
      return P.api('DELETE', 'admin/devices/' + d.id).then(function () { P.toast(T('dev.deleted')); load(); return true; });
    }).catch(function (e) { P.warn(e); return false; });
  }
  /** „Verbinden“: a terminal with tmux shows the sessions first (resume, new, end); everything else opens directly. */
  function connectFlow(d, btn) {
    var tmux = d.protocol === 'ssh' && d.config && d.config.ssh_engine === 'term' && d.config.tmux_enabled && S.v3;
    var post = function (body, hostEl) {
      return P.api('POST', 'admin/devices/' + d.id + '/connect', body || {}).then(function (r) { return P.openSession(r.session.ref, hostEl); });
    };
    if (tmux && (d.kind !== 'host' || (d.host && d.host.platform === 'linux'))) {
      var own = d.config.tmux_name || null;
      return P.api('GET', 'admin/devices/' + d.id).then(function (r) {
        P.tmuxDialog({ device: { id: d.id, name: d.name, tmux: (r.device.ssh && r.device.ssh.tmux) || own, recording: d.config.recording }, base: 'admin/devices/' + d.id,
          sub: T('proto.ssh') + ' · ' + T('dev.engine_term'), connect: post });
      }).catch(P.warn);
    }
    var holder = btn && btn.parentNode ? btn.parentNode : null;
    if (btn) btn.disabled = true;
    return post({}, holder).catch(P.warn).then(function () { if (btn) btn.disabled = false; });
  }

  // ─── the list ───
  function address(d) {
    var c = d.config;
    var h = d.host;
    if (h && h.platform === 'android') return T('dev.phone');
    if (h && d.protocol === 'screen') return T('dev.pc_screen_addr');
    if (c.access_mode === 'gateway') return c.host + ':' + c.port;
    if (c.access_mode === 'external') return (c.external_hostname || '–') + ':' + (c.external_port || c.port);
    return c.host + ':' + c.port;
  }
  /** The way: icon, word, colour (home | vpn | agent | net | server). */
  function wayOf(d) {
    var k = d.way || (d.config.access_mode === 'gateway' ? 'home' : 'server');
    var c = d.config;
    if (k === 'home') return { kind: 'home', icon: 'home', text: T('way.home', { name: gwName(c) }), short: gwName(c) };
    if (k === 'vpn') return { kind: 'vpn', icon: 'shield', text: d.host ? T('way.app') : T('way.vpn'), short: d.host ? T('way.app') : T('way.vpn_short') };
    if (k === 'agent') return { kind: 'agent', icon: 'agent', text: T('way.agent'), short: T('way.agent') };
    if (k === 'net') return { kind: 'net', icon: 'globe', text: T('way.net'), short: T('way.net') };
    return { kind: 'server', icon: 'server', text: T('way.server'), short: T('way.server_short') };
  }
  function authOf(d) {
    var a = d.auth;
    if (a === 'failed') return { text: T('auth.failed'), tone: 'bad' };
    if (a === 'code') return { text: T(d.host && d.host.connect === 'open' ? 'auth.open' : 'auth.code'), tone: '' };
    if (a === 'gc_key') return { text: T('auth.gc_key'), tone: 'key' };
    if (!a) return { text: '–', tone: 'muted' };
    return { text: T('auth.' + a), tone: a === 'agent' ? 'key' : '' };
  }
  function glyphOf(d) {
    var h = d.host;
    if (h && h.platform === 'android') return 'phone';
    if (h && h.platform === 'windows') return 'pc';
    if (h && h.platform === 'linux') return 'shell';
    return d.protocol === 'ssh' ? 'server' : (d.protocol === 'telnet' ? 'shell' : 'pc');
  }
  function statusOf(d) {
    var st = d.status || {};
    if (d.enabled === false) return { cls: 'off', text: T('st.off') };
    if (d.host && !d.host.registered) return { cls: 'off', text: T('dev.unregistered') };
    if (d.maintenance) return { cls: 'warn', text: T('state.maintenance') };
    if (st.online === true) return { cls: 'ok', text: st.responseTime != null ? st.responseTime + ' ms' : T('state.online'), long: T('state.online') + (st.responseTime != null ? ' · ' + st.responseTime + ' ms' : '') };
    if (st.online === false) return { cls: 'bad', text: T('state.offline') };
    return { cls: '', text: T('state.unknown') };
  }
  function problem(d) {
    if (d.enabled === false) return false;
    return d.status.online === false || d.auth === 'failed' || !!d.listenerError || (d.credential && d.credential.readable === false) || !!d.rotationDue;
  }
  function connectable(d) {
    var h = d.host;
    // 1.8: a Linux device of the agent with SSH „ohne Code“ connects like a device made here (the terminal, tmux)
    if (h && h.platform === 'linux') return !!(d.enabled && h.connect === 'open' && h.registered && h.online && h.ssh && h.ssh.offered);
    return !!(d.config.browser_enabled && d.enabled && (!h || (h.platform !== 'android' && d.protocol === 'rdp' && h.rdpOffered !== false && h.connect === 'open' && h.registered && h.online && h.rdpEnabled !== false)));
  }
  function busy(b, p) { if (b) b.disabled = true; return p.catch(P.warn).then(function () { if (b) b.disabled = false; }); }
  function keyInline(d) {
    return !!(S.features.keySetup && d.kind === 'target' && d.protocol === 'ssh' && (d.auth === 'password' || d.auth === 'failed' || d.auth == null));
  }

  /** Every action of a device: the inline ones (icons), the menu ⋮ and the sheet on phones. */
  function actionsOf(d) {
    var h = d.host;
    var n = { name: d.name };
    var A = {};
    if (connectable(d)) A.connect = { icon: 'connect', text: T('dev.connect'), label: T('act.connect', n), run: function (b) { return connectFlow(d, b); } };
    if (d.kind === 'target' && d.protocol === 'ssh' && S.features.keySetup) A.key = { icon: 'key', text: d.auth === 'gc_key' ? T('ed.k_again') : T('act.key_setup'), label: T('act.key_setup_n', n), tone: 'key', run: function () { keySetup(d); } };
    if (!h) A.check = { icon: 'check', text: T('dev.check'), label: T('act.check', n), tip: T('act.check_tip'), run: function (b) { return busy(b, P.api('POST', 'admin/devices/' + d.id + '/check').then(load)); } };
    else A.open = { icon: h.allowOpen ? 'unlock' : 'lock', text: h.allowOpen ? T('dev.lock_open') : T('dev.allow_open'), label: (h.allowOpen ? T('dev.lock_open') : T('dev.allow_open')) + ' – ' + d.name, tone: h.allowOpen ? '' : 'ok',
      run: function (b) { return busy(b, P.api('POST', 'admin/devices/' + d.id + '/allow-open', { allowOpen: !h.allowOpen }).then(load)); } };
    if (d.config.wol_enabled && d.config.wol_mac_address) A.wake = { icon: 'wake', text: T('dev.wake'), label: T('act.wake', n), run: function (b) { return busy(b, P.api('POST', 'admin/devices/' + d.id + '/wake').then(function () { P.toast(T('dev.woken')); })); } };
    A.edit = { icon: 'edit', text: T('dev.edit'), label: T('act.edit', n), run: function () { openEditor(d.id); } };
    A.power = { icon: 'power', text: d.enabled ? T('dev.disable') : T('dev.enable'), label: (d.enabled ? T('act.disable', n) : T('act.enable', n)), tone: d.enabled ? '' : 'ok',
      run: function (b) { return busy(b, P.api('POST', 'admin/devices/' + d.id + '/toggle').then(load)); } };
    A.del = { icon: 'trash', text: T('dev.delete'), label: T('act.delete', n), tone: 'danger', danger: true, run: function () { removeDevice(d); } };
    if (d.protocol === 'ssh' && d.config.ssh_engine === 'term' && d.config.tmux_enabled && S.v3 && (d.kind === 'target' || connectable(d))) A.tmux = { icon: 'tmux', text: T('act.tmux'), label: T('act.tmux_n', n), run: function () { connectFlow(d); } };
    if (d.kind === 'target' && d.protocol === 'ssh' && S.wizard) A.agent = { icon: 'agent', text: T('act.agent'), label: T('act.agent_n', n), small: S.features.enroll ? T('act.code') : null, run: function () { openEditor(d.id, 'agent'); } };
    if (d.protocol === 'ssh' && S.v3) A.hostkey = { icon: 'hostkey', text: T('f.hostkey_reset'), label: T('f.hostkey_reset') + ' – ' + d.name, run: function () {
      P.confirmDialog(T('f.hostkey_reset_q', { name: d.name }), T('f.hostkey_reset')).then(function (ok) {
        if (!ok) return null;
        return P.api('DELETE', 'admin/devices/' + d.id + '/hostkey').then(function (r) { P.toast(r.removed ? T('f.hostkey_reset_done') : T('act.hostkey_none')); });
      }).catch(P.warn);
    } };
    if (window.GC && typeof window.GC.navigate === 'function') A.history = { icon: 'history', text: T('act.history'), label: T('act.history') + ' – ' + d.name, run: function () { window.GC.navigate('sessions'); } };
    if (d.kind === 'target') A.dup = { icon: 'dup', text: T('act.duplicate'), label: T('act.duplicate') + ' – ' + d.name, run: function () {
      P.api('POST', 'admin/devices/' + d.id + '/duplicate').then(function (r) { P.toast(T('act.duplicated', { name: r.device.name })); load(); openEditor(r.device.id); }).catch(P.warn);
    } };
    if (d.rotationDue) A.rotated = { icon: 'renew', text: T('dev.rotated'), label: T('dev.rotated') + ' – ' + d.name, run: function () { P.api('POST', 'admin/devices/' + d.id + '/rotated').then(load).catch(P.warn); } };
    if (S.v3 && d.protocol === 'ssh' && d.config.ssh_engine === 'guac') A.switch = { icon: 'switch', text: T('dev.switch'), label: T('dev.switch') + ' – ' + d.name, run: function () { switchEngine([d.id], d.name); } };
    return A;
  }
  /** The menu ⋮: what is rare (and the key when it is not an icon of its own). */
  function menuItems(d, A) {
    var it = [];
    if (A.key && !keyInline(d)) it.push(A.key);
    if (A.tmux) it.push(A.tmux);
    if (A.agent) it.push(A.agent);
    if (A.wake && d.host) it.push(A.wake);
    if (A.hostkey || A.history || A.dup || A.rotated || A.switch) it.push({ sep: true });
    ['hostkey', 'history', 'dup', 'rotated', 'switch'].forEach(function (k) { if (A[k]) it.push(A[k]); });
    if (it.length && it[it.length - 1].sep) it.pop();
    if (it.length && it[0].sep) it.shift();
    return it.map(function (x) { return x.sep ? x : { icon: x.icon, label: x.text, small: x.small, danger: x.danger, run: function () { x.run(); } }; });
  }
  function ib(a, cls) {
    if (!a) return el('span', { class: 'rm-ib-gap' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' });
    var b = P.iconBtn({ icon: a.icon, label: a.label, tip: a.tip ? a.tip : a.text, tone: a.tone, cls: cls });
    b.addEventListener('click', function () { a.run(b); });
    return b;
  }
  function moreBtn(d, A, cls) {
    var items = menuItems(d, A);
    if (!items.length) return el('span', { class: 'rm-ib-gap' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' });
    var b = P.iconBtn({ icon: 'more', label: T('act.more', { name: d.name }), tip: T('act.more_tip'), cls: (cls || '') + ' flat' });
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', function () { P.menu(b, items); });
    return b;
  }
  function connectBtn(d, A, cls) {
    if (!A.connect) return el('span', { class: 'rm-ib-gap ' + (cls || '') });
    var b = el('button', { type: 'button', class: 'btn btn-sm btn-primary rm-conn ' + (cls || ''), 'aria-label': A.connect.label }, [P.icon('connect', 14), T('dev.connect')]);
    b.addEventListener('click', function () { A.connect.run(b); });
    return b;
  }

  function chips(d) {
    var h = d.host;
    var w = wayOf(d);
    var a = authOf(d);
    var box = el('div', { class: 'rm-badges' });
    box.appendChild(el('span', { class: 'rm-way ' + w.kind }, [P.icon(w.icon, 12), w.text]));
    box.appendChild(P.protoBadge(d.protocol === 'screen' ? 'screen' : d.protocol));
    if (d.auth && d.auth !== 'code') box.appendChild(el('span', { class: 'rm-badge', 'data-tone': a.tone === 'bad' ? 'crit' : (a.tone === 'key' ? 'good' : null), text: a.text }));
    if (h) {
      if (h.platform === 'linux') box.appendChild(el('span', { class: 'rm-badge', text: T('dev.linux') }));
      if (h.platform === 'android') box.appendChild(el('span', { class: 'rm-badge', text: T('dev.phone') }));
      if (h.platform === 'windows' && h.registered && h.screenView) box.appendChild(el('span', { class: 'rm-badge', text: T('dev.pc_screen') }));
      if (h.registered && h.rdpEnabled === false && d.protocol === 'rdp' && h.rdpOffered !== false) box.appendChild(el('span', { class: 'rm-badge', 'data-tone': 'warn', text: T('dev.rdp_off') }));
      box.appendChild(el('span', { class: 'rm-badge', text: T(h.connect === 'open' ? 'dev.share_open' : 'dev.share_code') }));
      if (!h.allowOpen) box.appendChild(el('span', { class: 'rm-badge', 'data-tone': 'warn', text: T('dev.open_locked') }));
    }
    if (d.config.wol_enabled && d.config.wol_mac_address) box.appendChild(el('span', { class: 'rm-badge', text: T('f.wol_enabled') }));
    if (d.activeSessions) box.appendChild(el('span', { class: 'rm-badge', 'data-tone': 'good', text: T('dev.active', { n: d.activeSessions }) }));
    if (d.listenerError) box.appendChild(el('span', { class: 'rm-badge', 'data-tone': 'crit', 'data-tip': d.listenerError, tabindex: '0', text: T('dev.listener_error') }));
    if (d.credential && d.credential.readable === false) box.appendChild(el('span', { class: 'rm-badge', 'data-tone': 'crit', text: T('dev.cred_unreadable') }));
    if (d.rotationDue) box.appendChild(el('span', { class: 'rm-badge', 'data-tone': 'warn', text: T('dev.rotation_due') }));
    if (!d.config.browser_enabled) box.appendChild(el('span', { class: 'rm-badge', text: T('dev.apps_only') }));
    if (d.protocol === 'ssh' && S.v3 && d.config.ssh_engine === 'guac') box.appendChild(el('span', { class: 'rm-badge', text: T('dev.engine_guac') + (d.config.term_tested_at ? ' · ' + T('dev.term_tested') : '') }));
    if (d.config.recording === 'optional' || d.config.recording === 'always') box.appendChild(el('span', { class: 'rm-badge', 'data-tone': d.config.recording === 'always' ? 'warn' : null, text: T('dev.rec_' + d.config.recording) }));
    return box;
  }
  function subLine(d) {
    var h = d.host;
    var sub = [];
    if (d.status && d.status.lastCheck && !h) sub.push(T('dev.checked', { ago: P.ago(d.status.lastCheck) }));
    else if (!h) sub.push(T('dev.not_checked'));
    if (d.protocol === 'ssh' && d.config.ssh_engine === 'term' && !h) sub.push(T('dev.engine_term') + (d.config.tmux_enabled ? ' · tmux' : ''));
    if (h) {
      if (h.osUser) sub.push(T('dev.os_user', { name: h.osUser }));
      if (h.platform === 'linux') {
        if (h.ssh && h.ssh.offered) sub.push(T('dev.linux_ssh', { name: h.ssh.user || '?' }) + (h.ssh.tmux ? ' · tmux ' + (h.ssh.tmuxVersion || '') : ' · ' + T('dev.linux_no_tmux')));
        if (h.desktop) sub.push(T('dev.linux_desktop', { kind: h.desktop.kind || '?', protocol: String(h.desktop.protocol || '').toUpperCase(), port: h.desktop.port }) + (h.desktop.ready ? '' : ' · ' + T('dev.linux_desktop_off')));
        if (h.hostKey) sub.push(T('dev.linux_hostkey', { alg: h.hostKey.alg || '' }));
      }
    }
    if (!d.access.open) sub.push(T('dev.restricted', { n: d.access.users.length + d.access.groups.length + d.access.tokens.length }));
    return sub.join(' · ');
  }
  function titleSub(d) {
    var h = d.host;
    if (h) return (h.platform === 'android' ? T('dev.phone') : (h.platform === 'linux' ? (d.config.host + ':' + d.config.port) : T('dev.windows_pc'))) + ' · ' + T('dev.owner', { name: h.ownerName || '#' + h.owner });
    return address(d);
  }
  /** The short line of a problem with the fitting button (cards). */
  function problemNote(d, A) {
    if (d.enabled === false) return null;
    if (d.auth === 'failed' && d.lastAuthFailed) {
      var f = d.lastAuthFailed;
      var t = f.username ? T('dev.auth_failed_as', { when: P.when(f.at), user: f.username }) : T('dev.auth_failed_at', { when: P.when(f.at) });
      return el('div', { class: 'rm-minote' }, [P.icon('warn', 14), el('span', null, [t + ' ', A.key ? el('button', { type: 'button', class: 'rmx-lnk', text: T('act.key_setup'), on: { click: function () { A.key.run(); } } })
        : el('button', { type: 'button', class: 'rmx-lnk', text: T('dev.edit_creds'), on: { click: function () { openEditor(d.id, 'auth'); } } })])]);
    }
    if (d.status.online === false && !d.host) {
      return el('div', { class: 'rm-minote warn' }, [P.icon('warn', 14), el('span', null, [T('dev.offline_note') + ' ', el('button', { type: 'button', class: 'rmx-lnk', text: A.wake ? T('dev.wake') : T('dev.check'), on: { click: function (ev) { (A.wake || A.check).run(ev.currentTarget); } } })])]);
    }
    if (d.rotationDue) return el('div', { class: 'rm-minote warn' }, [P.icon('key', 14), el('span', null, [T('dev.rotation_note') + ' ', el('button', { type: 'button', class: 'rmx-lnk', text: T('dev.rotated'), on: { click: function () { A.rotated.run(); } } })])]);
    return null;
  }

  function dico(d, small) {
    var w = wayOf(d);
    return el('span', { class: 'rm-dico ' + w.kind + (small ? ' sm' : '') }, [P.icon(glyphOf(d), small ? 15 : 18)]);
  }
  function statusEl(d, long) {
    var s = statusOf(d);
    return el('span', { class: 'rm-st' }, [el('span', { class: 'rm-sdot ' + s.cls }), long && s.long ? s.long : s.text]);
  }

  function card(d) {
    var A = actionsOf(d);
    var foot = el('div', { class: 'rm-dfoot' });
    foot.appendChild(connectBtn(d, A));
    foot.appendChild(el('span', { class: 'rmx-sp' }));
    [keyInline(d) ? A.key : null, A.check || A.open, A.wake && !d.host ? A.wake : null, A.edit, A.power, A.del].forEach(function (a) { if (a) foot.appendChild(ib(a)); });
    foot.appendChild(moreBtn(d, A));
    return el('article', { class: 'rm-dc' + (d.enabled === false ? ' off' : '') + (problem(d) ? ' bad' : ''), 'data-device': String(d.id), 'aria-label': d.name }, [
      el('div', { class: 'rm-dch' }, [dico(d), el('div', { class: 'rm-dct' }, [el('b', { text: d.name }), el('small', { text: titleSub(d) })]), statusEl(d)]),
      chips(d),
      el('div', { class: 'rm-dsub', text: subLine(d) }),
      d.config.description ? el('div', { class: 'rm-dsub', text: d.config.description }) : null,
      problemNote(d, A),
      foot,
    ]);
  }

  // the table: every icon in its own column, „Verbinden“ always at the same place
  var COLS = [['name', 'col.name'], ['addr', 'col.addr'], ['way', 'col.way'], ['proto', 'col.proto'], ['status', 'col.status'], ['auth', 'col.auth'], ['checked', 'col.checked']];
  function tableRow(d) {
    var A = actionsOf(d);
    var acts = el('div', { class: 'rm-tacts' }, [connectBtn(d, A, 'a-con'), ib(keyInline(d) ? A.key : (A.open || (d.host ? null : A.wake)), 'a-ctx'), ib(A.check || null, 'a-chk'), ib(A.edit, 'a-edit'), ib(A.power, 'a-pow'), ib(A.del, 'a-del'), moreBtn(d, A, 'a-more')]);
    var w = wayOf(d);
    var a = authOf(d);
    var small = d.host ? T('dev.owner', { name: d.host.ownerName || '#' + d.host.owner }) : [d.config.ssh_engine === 'term' && d.protocol === 'ssh' ? (d.config.tmux_enabled ? 'tmux · ' : '') + T('dev.engine_term') : null,
      d.activeSessions ? T('dev.active', { n: d.activeSessions }) : null, d.enabled === false ? T('state.disabled') : null].filter(Boolean).join(' · ');
    return el('tr', { class: (d.enabled === false ? 'off' : '') + (problem(d) ? ' bad' : ''), 'data-device': String(d.id) }, [
      el('td', null, [el('div', { class: 'rm-nm' }, [dico(d, true), el('div', null, [el('b', { text: d.name }), small ? el('small', { text: small }) : null])])]),
      el('td', { class: 'mono', text: address(d) }),
      el('td', null, [el('span', { class: 'rm-way ' + w.kind }, [P.icon(w.icon, 12), w.short])]),
      el('td', null, [P.protoBadge(d.protocol)]),
      el('td', null, [statusEl(d, true)]),
      el('td', null, [el('span', { class: 'rm-authl ' + a.tone, text: a.text })]),
      el('td', { class: 'rm-when', text: d.host ? (d.host.lastSeen ? P.ago(d.host.lastSeen) : '–') : (d.status.lastCheck ? P.ago(d.status.lastCheck) : '–') }),
      el('td', null, [acts]),
    ]);
  }
  function table(list) {
    var head = el('tr');
    COLS.forEach(function (c) {
      var on = S.sort.key === c[0];
      var b = el('button', { type: 'button', class: 'rm-th', on: { click: function () { setSort(c[0], on ? !S.sort.desc : false); } } }, [T(c[1]), on ? P.icon(S.sort.desc ? 'down' : 'chev', 12) : null]);
      head.appendChild(el('th', { scope: 'col', class: on ? 'sorted' : null, 'aria-sort': on ? (S.sort.desc ? 'descending' : 'ascending') : 'none' }, [b]));
    });
    head.appendChild(el('th', { scope: 'col', class: 'rm-th-acts', text: T('col.actions') }));
    var tb = el('tbody');
    S.enroll.forEach(function (e) { if (matchesEnroll(e)) tb.appendChild(enrollRow(e)); });
    list.forEach(function (d) { tb.appendChild(tableRow(d)); });
    return el('div', { class: 'rm-dtw' }, [el('table', { class: 'rm-dt' }, [el('thead', null, [head]), tb])]);
  }

  /** Phones: a compact list, „Verbinden“ as a round icon button and ⋮ with a sheet of every action. */
  function mrow(d) {
    var A = actionsOf(d);
    var w = wayOf(d);
    var parts = [T('proto.' + d.protocol), w.short];
    if (d.auth === 'failed') parts.push(T('auth.failed'));
    else if (d.status.online === false) parts.push(T('state.offline'));
    else if (d.host) parts.push(d.host.ownerName || '');
    else if (d.auth === 'gc_key') parts.push(T('auth.gc_key'));
    var row = el('div', { class: 'rm-mrow' + (problem(d) ? ' bad' : '') + (d.enabled === false ? ' off' : ''), 'data-device': String(d.id) }, [
      dico(d), el('div', { class: 'rm-dct' }, [el('b', { text: d.name }), el('small', { class: d.auth === 'failed' ? 'bad' : null, text: parts.filter(Boolean).join(' · ') })]),
      statusEl(d),
    ]);
    if (A.connect) { var c = P.iconBtn({ icon: 'connect', label: A.connect.label, tone: 'prim', cls: 'round' }); c.addEventListener('click', function () { A.connect.run(c); }); row.appendChild(c); }
    var m = P.iconBtn({ icon: 'more', label: T('act.more', { name: d.name }), cls: 'flat lg' });
    m.addEventListener('click', function () {
      var items = [];
      if (A.connect) items.push({ icon: 'connect', label: A.connect.text, primary: true, run: function () { A.connect.run(); } });
      ['key', 'check', 'open', 'wake', 'edit', 'tmux', 'agent', 'hostkey', 'dup', 'rotated', 'switch', 'history', 'power'].forEach(function (k) { if (A[k]) items.push({ icon: A[k].icon, label: A[k].text, run: function () { A[k].run(); } }); });
      items.push({ icon: 'trash', label: A.del.text, danger: true, run: function () { A.del.run(); } });
      P.sheet(d.name, address(d) + ' · ' + wayOf(d).text, items);
    });
    row.appendChild(m);
    return row;
  }

  // ─── 1.8: codes for the agent that are not redeemed yet: placeholders in the list ───
  function matchesEnroll(e) { return !S.q || (e.name + ' ' + (e.ownerName || '')).toLowerCase().indexOf(S.q) >= 0; }
  function enrollInfo(e) {
    var left = Math.max(0, Math.round((Date.parse(e.expiresAt) - Date.now()) / 1000));
    var mask = e.code ? e.code.slice(0, 4) + '-…-' + e.code.slice(-4) : null;
    if (e.state === 'conflict') return { cls: 'bad', st: T('ag.st_conflict'), text: T('ag.ph_conflict') };
    if (e.state === 'expired' || (e.state === 'waiting' && left <= 0)) return { cls: 'off', st: T('ag.st_expired'), text: T('ag.ph_expired'), expired: true };
    if (e.state === 'redeemed') return { cls: 'run', st: T('ag.st_redeemed'), text: e.hint ? T('ag.h.' + e.hint) : T(e.steps.vpn ? 'ag.ph_vpn' : 'ag.ph_redeemed', { ip: e.vpnIp || '' }) };
    return { cls: 'run', st: T('ag.waiting'), text: T('ag.ph_waiting', { code: mask || '', t: Math.floor(left / 60) + ':' + ('0' + (left % 60)).slice(-2) }) };
  }
  function enrollActions(e) {
    var i = enrollInfo(e);
    var show = el('button', { type: 'button', class: 'btn btn-sm', on: { click: function () { agentDialog(e); } } }, [P.icon(i.expired ? 'renew' : 'code', 14), T(i.expired ? 'ag.new_code' : (e.state === 'conflict' ? 'ag.decide' : 'ag.show_cmd'))]);
    var del = P.iconBtn({ icon: 'trash', label: T('ag.remove_n', { name: e.name }), tip: T('ag.remove'), tone: 'danger', onClick: function () {
      P.confirmDialog(T('ag.remove_q', { name: e.name }), T('ag.remove')).then(function (ok) {
        if (!ok) return null;
        return P.api('DELETE', 'admin/enroll/' + encodeURIComponent(e.ticket)).then(function () { loadEnroll(); });
      }).catch(P.warn);
    } });
    return [show, del];
  }
  function enrollCard(e) {
    var i = enrollInfo(e);
    var acts = enrollActions(e);
    return el('article', { class: 'rm-dc rm-ph ' + i.cls, 'aria-label': e.name }, [
      el('div', { class: 'rm-dch' }, [el('span', { class: 'rm-dico agent' }, [P.icon('agent', 18)]), el('div', { class: 'rm-dct' }, [el('b', { text: e.name }), el('small', { text: T('ag.ph_sub', { owner: e.ownerName || '#' + e.ownerId }) + (e.adoptDeviceId ? ' · ' + T('ag.ph_adopt') : '') })]),
        el('span', { class: 'rm-st' }, [el('span', { class: 'rm-sdot ' + (i.cls === 'run' ? 'run' : i.cls) }), i.st])]),
      el('div', { class: 'rm-minote info' }, [P.icon('code', 14), el('span', { text: i.text })]),
      el('div', { class: 'rm-dfoot' }, [acts[0], el('span', { class: 'rmx-sp' }), acts[1]]),
    ]);
  }
  function enrollRow(e) {
    var i = enrollInfo(e);
    var acts = enrollActions(e);
    return el('tr', { class: 'rm-ph ' + i.cls }, [
      el('td', null, [el('div', { class: 'rm-nm' }, [el('span', { class: 'rm-dico agent sm' }, [P.icon('agent', 15)]), el('div', null, [el('b', { text: e.name }), el('small', { text: T('ag.ph_sub', { owner: e.ownerName || '#' + e.ownerId }) })])])]),
      el('td', { colspan: '6', class: 'rm-ph-text', text: i.text }),
      el('td', null, [el('div', { class: 'rm-tacts ph' }, acts)]),
    ]);
  }
  function enrollM(e) {
    var i = enrollInfo(e);
    return el('div', { class: 'rm-mrow rm-ph ' + i.cls }, [el('span', { class: 'rm-dico agent' }, [P.icon('agent', 18)]), el('div', { class: 'rm-dct' }, [el('b', { text: e.name }), el('small', { text: i.text })]),
      P.iconBtn({ icon: i.expired ? 'renew' : 'code', label: T(i.expired ? 'ag.new_code' : 'ag.show_cmd') + ' – ' + e.name, cls: 'lg', onClick: function () { agentDialog(e); } })]);
  }
  /** The code of a placeholder again (or „Neuer Code“), in the large dialog. */
  function agentDialog(e) {
    return P.api('GET', 'admin/enroll/' + encodeURIComponent(e.ticket)).then(function (r) {
      var en = r.enrollment;
      var expired = en.state === 'expired' || (en.state === 'waiting' && Date.parse(en.expiresAt) <= Date.now());
      var adopt = en.adoptDeviceId ? S.devices.filter(function (d) { return d.id === en.adoptDeviceId; })[0] || null : null;
      var dlg = P.bigDialog({ title: T('ag.title'), sub: en.name, size: 'xl', onClose: function () { if (ctl) ctl.stop(); loadEnroll(); } });
      var box = el('div', { class: 'rm-agbox' });
      dlg.body.appendChild(box);
      var ctl = window.RMA.panel(box, { adopt: adopt, enrollment: en, me: S.me, name: en.name, user: en.options && en.options.ssh ? en.options.ssh.user : '',
        onRegistered: function (x) { load(); if (x.state === 'registered') { P.toast(T('ag.registered', { name: x.name })); } } });
      if (expired) setTimeout(function () { var b = box.querySelector('.rm-ag-right .btn-primary'); if (b) b.focus(); }, 0);
      dlg.foot.appendChild(el('span', { class: 'rmx-small', text: T('ag.close_ok') }));
      dlg.foot.appendChild(el('span', { class: 'rmx-sp' }));
      dlg.foot.appendChild(el('button', { type: 'button', class: 'btn btn-primary', text: T('common.close'), on: { click: function () { dlg.close(null); } } }));
    }).catch(function (err) { P.warn(err); loadEnroll(); });
  }

  // ─── toolbar: search, protocol chips, filters, sorting, the view ───
  S.q = '';
  S.proto = '';
  S.f = { status: '', way: '', auth: '' };
  S.sort = { key: 'name', desc: false };
  S.view = null;
  var FILTERS = {
    status: ['online', 'offline', 'problems', 'off'],
    way: ['home', 'vpn', 'agent', 'net', 'server'],
    auth: ['password', 'gc_key', 'own_key', 'agent', 'code', 'failed'],
  };
  function fitStatus(d, v) {
    if (v === 'online') return d.enabled !== false && d.status.online === true;
    if (v === 'offline') return d.enabled !== false && d.status.online === false;
    if (v === 'problems') return problem(d);
    if (v === 'off') return d.enabled === false;
    return true;
  }
  function fits(d, skip) {
    if (skip !== 'proto' && S.proto && d.protocol !== S.proto) return false;
    if (skip !== 'status' && S.f.status && !fitStatus(d, S.f.status)) return false;
    if (skip !== 'way' && S.f.way && d.way !== S.f.way) return false;
    if (skip !== 'auth' && S.f.auth && d.auth !== S.f.auth) return false;
    if (!S.q) return true;
    var h = d.host;
    return [d.name, d.config.host, d.config.external_hostname, d.config.description, (d.config.tags || []).join(' '), h ? h.ownerName : '', wayOf(d).text].join(' ').toLowerCase().indexOf(S.q) >= 0;
  }
  var RANK = { ok: 0, warn: 1, '': 2, bad: 3, off: 4 };
  function sortKey(d) {
    var k = S.sort.key;
    if (k === 'addr') return address(d);
    if (k === 'way') return wayOf(d).short;
    if (k === 'proto') return d.protocol;
    if (k === 'status') return String(problem(d) ? 0 : 1) + (RANK[statusOf(d).cls] != null ? RANK[statusOf(d).cls] : 2);
    if (k === 'auth') return authOf(d).text;
    if (k === 'checked') return -(Date.parse(d.host ? d.host.lastSeen : d.status.lastCheck) || 0);
    return d.name.toLowerCase();
  }
  function setSort(key, desc) {
    S.sort = { key: key, desc: !!desc };
    $('#rm-sort').value = key + (desc ? ':desc' : '');
    draw();
  }
  var narrowMq = window.matchMedia ? window.matchMedia('(max-width: 699px)') : null;
  function narrow() { return !!(narrowMq && narrowMq.matches); }
  function viewOf() {
    if (S.view) return S.view;
    var saved = null;
    try { saved = window.localStorage.getItem('rm.devices.view'); } catch (e) { saved = null; }
    if (saved === 'cards' || saved === 'table') return saved;
    return S.devices.length <= 12 ? 'cards' : 'table';
  }
  function setView(v) {
    S.view = v;
    try { window.localStorage.setItem('rm.devices.view', v); } catch (e) { /* the choice stays for this visit */ }
    draw();
  }
  function drawToolbar() {
    var pb = P.clear($('#rm-protos'));
    var base = S.devices.filter(function (d) { return fits(d, 'proto'); });
    [['', T('wz.all')], ['ssh', 'SSH'], ['rdp', 'RDP'], ['vnc', 'VNC'], ['telnet', 'Telnet']].forEach(function (x) {
      var n = x[0] ? base.filter(function (d) { return d.protocol === x[0]; }).length : base.length;
      if (x[0] && !n && S.proto !== x[0]) return;
      pb.appendChild(el('button', { type: 'button', class: 'rmx-fchip', 'aria-pressed': S.proto === x[0] ? 'true' : 'false', on: { click: function () { S.proto = x[0]; draw(); } } }, [x[1], el('span', { class: 'n', text: ' ' + n })]));
    });
    var ab = P.clear($('#rm-active'));
    Object.keys(S.f).forEach(function (g) {
      if (!S.f[g]) return;
      ab.appendChild(el('button', { type: 'button', class: 'rmx-fchip on rm-fx', 'aria-label': T('dev.filter_remove', { what: T('flt.' + g) + ': ' + T('flt.' + g + '.' + S.f[g]) }), on: { click: function () { S.f[g] = ''; draw(); } } },
        [T('flt.' + g) + ': ' + T('flt.' + g + '.' + S.f[g]), P.icon('x', 12)]));
    });
    var nf = Object.keys(S.f).filter(function (g) { return S.f[g]; }).length;
    var fb = $('#rm-filter');
    P.clear(fb);
    fb.appendChild(P.icon('filter', 14));
    fb.appendChild(document.createTextNode(nf ? T('dev.filter_n', { n: nf }) : T('dev.filter')));
    var vb = P.clear($('#rm-view'));
    var v = viewOf();
    [['cards', 'cards', T('dev.view_cards')], ['table', 'table', T('dev.view_table')]].forEach(function (x) {
      vb.appendChild(el('button', { type: 'button', 'aria-pressed': v === x[0] ? 'true' : 'false', 'aria-label': x[2], 'data-tip': narrow() ? x[2] : null, on: { click: function () { setView(x[0]); } } }, [P.icon(x[1], 14), el('span', { class: 'rm-vtext', text: x[2] })]));
    });
  }
  function filterPop() {
    var anchor = $('#rm-filter');
    if (document.querySelector('.rm-pop')) { closePop(); return; }
    var box = el('div', { class: 'rm-pop', role: 'dialog', 'aria-label': T('dev.filter') });
    function drawPop() {
      P.clear(box);
      Object.keys(FILTERS).forEach(function (g) {
        var base = S.devices.filter(function (d) { return fits(d, g); });
        var chips2 = el('div', { class: 'rm-fchips' });
        FILTERS[g].forEach(function (v) {
          var n = base.filter(function (d) { return g === 'status' ? fitStatus(d, v) : d[g] === v; }).length;
          chips2.appendChild(el('button', { type: 'button', class: 'rmx-fchip', 'aria-pressed': S.f[g] === v ? 'true' : 'false', disabled: !n && S.f[g] !== v,
            on: { click: function () { S.f[g] = S.f[g] === v ? '' : v; draw(); drawPop(); } } }, [T('flt.' + g + '.' + v), el('span', { class: 'n', text: ' ' + n })]));
        });
        box.appendChild(el('div', { class: 'rm-pop-g' }, [el('b', { text: T('flt.' + g) }), chips2]));
      });
      box.appendChild(el('p', { class: 'rmx-small', text: T('flt.problems_hint') }));
      box.appendChild(el('div', { class: 'acts' }, [el('button', { type: 'button', class: 'btn btn-sm rmx-ghost', text: T('flt.reset'), on: { click: function () { S.f = { status: '', way: '', auth: '' }; draw(); drawPop(); } } }),
        el('span', { class: 'rmx-sp' }), el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: T('common.close'), on: { click: closePop } })]));
    }
    drawPop();
    document.body.appendChild(box);
    var r = anchor.getBoundingClientRect();
    box.style.left = Math.max(8, Math.min(window.innerWidth - box.offsetWidth - 8, r.left)) + 'px';
    box.style.top = (r.bottom + 6) + 'px';
    anchor.setAttribute('aria-expanded', 'true');
    var first = box.querySelector('button:not([disabled])');
    if (first) first.focus();
    setTimeout(function () { document.addEventListener('mousedown', outside, true); }, 0);
    box.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { closePop(); anchor.focus(); } });
    function outside(ev) { if (!box.contains(ev.target) && !anchor.contains(ev.target)) closePop(); }
    S.popOff = function () { document.removeEventListener('mousedown', outside, true); };
  }
  function closePop() {
    var b = document.querySelector('.rm-pop');
    if (b) b.remove();
    if (S.popOff) { S.popOff(); S.popOff = null; }
    $('#rm-filter').setAttribute('aria-expanded', 'false');
  }

  function stats() {
    var box = P.clear($('#rm-stats'));
    var n = function (f) { return S.devices.filter(f).length; };
    var rows = [[T('stat.total'), S.devices.length], [T('state.online'), n(function (d) { return d.enabled !== false && d.status.online === true; })],
      [T('state.offline'), n(function (d) { return d.enabled !== false && d.status.online === false; })]];
    var failed = n(function (d) { return d.auth === 'failed'; });
    if (failed) rows.push([T('auth.failed'), failed, 'crit']);
    if (n(function (d) { return d.maintenance; })) rows.push([T('state.maintenance'), n(function (d) { return d.maintenance; })]);
    if (n(function (d) { return d.rotationDue; })) rows.push([T('stat.rotation'), n(function (d) { return d.rotationDue; }), 'warn']);
    rows.push([T('stat.sessions'), S.devices.reduce(function (a, d) { return a + (d.activeSessions || 0); }, 0)]);
    if (S.enroll.length) rows.push([T('stat.waiting'), S.enroll.length]);
    rows.forEach(function (x) { box.appendChild(el('div', { class: 'rm-stat' + (x[2] ? ' ' + x[2] : '') }, [el('b', { text: String(x[1]) }), el('span', { text: x[0] })])); });
  }

  function draw() {
    P.hideTip();
    P.closeMenu();
    S.q = $('#rm-search').value.trim().toLowerCase();
    var list = S.devices.filter(function (d) { return fits(d); });
    list.sort(function (a, b) {
      var x = sortKey(a);
      var y = sortKey(b);
      var c = x < y ? -1 : (x > y ? 1 : a.name.localeCompare(b.name));
      return S.sort.desc ? -c : c;
    });
    var box = P.clear($('#rm-devices'));
    var v = viewOf();
    var enr = S.enroll.filter(matchesEnroll);
    if (narrow()) {
      var ml = el('div', { class: 'rm-mlist' });
      enr.forEach(function (e) { ml.appendChild(enrollM(e)); });
      list.forEach(function (d) { ml.appendChild(mrow(d)); });
      box.appendChild(ml);
    } else if (v === 'table') {
      box.appendChild(table(list));
    } else {
      var grid = el('div', { class: 'rm-dgrid' });
      enr.forEach(function (e) { grid.appendChild(enrollCard(e)); });
      list.forEach(function (d) { grid.appendChild(card(d)); });
      box.appendChild(grid);
    }
    $('#rm-none').hidden = !S.loaded || S.devices.length > 0 || S.enroll.length > 0;
    $('#rm-nomatch').hidden = !S.devices.length || list.length > 0;
    $('#rm-count').textContent = T('dev.count', { n: list.length, total: S.devices.length });
    $('#rm-switch-all').hidden = !(S.v3 && S.devices.some(function (d) { return d.protocol === 'ssh' && d.config.ssh_engine === 'guac'; }));
    drawToolbar();
    stats();
  }

  var enrollTimer = null;
  function loadEnroll() {
    if (!S.features.enroll) { S.enroll = []; return Promise.resolve(); }
    return P.api('GET', 'admin/enroll').then(function (r) {
      S.enroll = r.enrollments || [];
      draw();
      clearTimeout(enrollTimer);
      // the list asks every 15 seconds while placeholders are there
      if (S.enroll.length) enrollTimer = setTimeout(function () { if (!document.querySelector('.rm-dlg-ov')) loadEnroll().then(function () { if (S.enroll.length === 0) load(); }); else loadEnroll(); }, 15000);
    }).catch(function () { /* the placeholders wait */ });
  }

  function load() {
    return P.api('GET', 'admin/devices').then(function (r) {
      S.devices = r.devices || [];
      S.gateways = r.gateways || [];
      S.pools = r.pools || [];
      S.gwList = !!r.available;
      S.wizard = r.wizard === true;
      S.features = r.features || {};
      S.loaded = true;
      draw();
      return loadEnroll();
    }).catch(P.warn);
  }

  $('#rm-srch-ico').appendChild(P.icon('search', 15));
  $('#rm-search').addEventListener('input', draw);
  var sortSel = $('#rm-sort');
  [['name', 'sort.name'], ['name:desc', 'sort.name_desc'], ['status', 'sort.status'], ['way', 'sort.way'], ['proto', 'sort.proto'], ['auth', 'sort.auth'], ['checked', 'sort.checked']].forEach(function (x) {
    sortSel.appendChild(el('option', { value: x[0], text: T(x[1]) }));
  });
  sortSel.addEventListener('change', function () { var p = sortSel.value.split(':'); S.sort = { key: p[0], desc: p[1] === 'desc' }; draw(); });
  $('#rm-filter').addEventListener('click', filterPop);
  if (narrowMq) { var onMq = function () { draw(); }; if (narrowMq.addEventListener) narrowMq.addEventListener('change', onMq); else if (narrowMq.addListener) narrowMq.addListener(onMq); }
  $('#rm-add').addEventListener('click', function () { addDevice(); });
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
  // who I am (the owner „Ich“ of a code for the agent)
  if (P.CTX.userId) S.me = P.CTX.userId;
  P.api('GET', 'admin/whoami').then(function (r) { if (r && r.user) S.me = r.user.id; }).catch(function () {});
  load();
})();
