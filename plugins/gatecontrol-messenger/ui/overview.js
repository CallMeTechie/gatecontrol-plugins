/* Admin page "Übersicht": numbers, storage, settings — never a message, a title or a name. */
(function () {
  'use strict';
  var M = window.MS;
  var T = M.T;
  var $ = M.$;
  var el = M.el;
  var state = { settings: null, options: null, switches: {} };

  function option(sel, values, label, current) {
    M.clear(sel);
    values.forEach(function (v) { sel.appendChild(el('option', { value: String(v), text: label(v) })); });
    sel.value = String(current);
  }
  function retentionLabel(d) { return d === 0 ? T('admin.retention_forever') : (d >= 365 ? T('admin.years', { n: Math.round(d / 365) }) : T('admin.days', { n: d })); }
  function editLabel(m) { return m === 0 ? T('admin.edit_never') : (m >= 1440 ? T('admin.day1') : (m >= 60 ? T('admin.hours', { n: m / 60 }) : T('admin.minutes', { n: m }))); }
  function voiceLabel(s) { return T('admin.minutes', { n: s / 60 }); }
  function ttlLabel(m) { return m >= 1440 ? T('admin.day1') : (m >= 60 ? T('admin.hours', { n: m / 60 }) : T('admin.minutes', { n: m })); }
  function approversLabel(v) { return T('admin.approvers_' + v); }
  function grantLabel(d) { return d === 1 ? T('admin.day1') : T('admin.days', { n: d }); }

  function renderOverview(o) {
    $('#ms-t-accounts').textContent = String(o.accounts.total);
    $('#ms-t-accounts-s').textContent = T('admin.accounts_sub', { n: o.accounts.activeToday });
    var c = o.conversations;
    $('#ms-t-chats').textContent = String(c.direct + c.groups + c.managed);
    $('#ms-t-chats-s').textContent = T('admin.chats_sub', { direct: c.direct, groups: c.groups, managed: c.managed });
    $('#ms-t-today').textContent = String(o.messages.today);
    $('#ms-t-today-s').textContent = T('admin.today_sub', { n: o.messages.fromPluginsToday, week: o.messages.last7Days });
    var u = o.storage.usage;
    var k = o.storage.byKind || {};
    if (u) {
      $('#ms-t-storage').textContent = M.bytes(u.bytes);
      var pct = u.quota ? Math.min(100, (u.bytes / u.quota) * 100) : 0;
      var bar = $('#ms-t-bar');
      bar.firstChild.style.width = pct.toFixed(1) + '%';
      bar.className = 'ms-bar' + (pct >= 95 ? ' is-crit' : (pct >= 80 ? ' is-warn' : ''));
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuenow', String(Math.round(pct)));
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      bar.setAttribute('aria-label', T('admin.tile_storage'));
      $('#ms-t-storage-s').textContent = T('admin.storage_sub', { quota: M.bytes(u.quota), images: M.bytes(k.image || 0), files: M.bytes(k.file || 0), voice: M.bytes(k.voice || 0) });
    } else {
      $('#ms-t-storage').textContent = '–';
      $('#ms-t-storage-s').textContent = T('admin.storage_unknown');
    }
    $('#ms-errors').textContent = String(o.errors7Days || 0);
    // 1.4.0: counts only
    var v = o.v14;
    if (v) {
      $('#ms-v-status').textContent = T('admin.v14_status_v', { status: v.statusesActive, stories: v.storiesActive });
      $('#ms-v-polls').textContent = String(v.pollsOpen);
      $('#ms-v-events').textContent = T('admin.v14_events_v', { events: v.eventsUpcoming, live: v.arrivalsLive });
      $('#ms-v-actions').textContent = T('admin.v14_actions_v', { actions: v.actionMessages7Days, cards: v.cards7Days });
      $('#ms-v-actions-s').textContent = v.actionsAvailable ? '' : T('admin.v14_actions_off');
      $('#ms-v-other').textContent = T('admin.v14_other_v', { blocks: v.blocks, reminders: v.remindersPending });
    }
  }

  function renderSettings(r) {
    state.settings = r.settings;
    state.options = r.options;
    var s = r.settings;
    option($('#ms-retention'), r.options.retentionDays, retentionLabel, s.retentionDays);
    option($('#ms-edit'), r.options.editWindowMin, editLabel, s.editWindowMin);
    option($('#ms-voice'), r.options.maxVoiceS, voiceLabel, s.maxVoiceS);
    // 1.5.0: home action requests and grants
    if (r.options.requestTtlMin) option($('#ms-req-ttl'), r.options.requestTtlMin, ttlLabel, s.requestTtlMin);
    if (r.options.requestApproversDefault) option($('#ms-req-approvers'), r.options.requestApproversDefault, approversLabel, s.requestApproversDefault);
    if (r.options.grantMaxDays) option($('#ms-grant-max'), r.options.grantMaxDays, grantLabel, s.grantMaxDays);
    $('#ms-req-approvers-s').textContent = T(r.familyRoles ? 'admin.request_approvers_hint' : 'admin.request_approvers_nofamily');
    var sw = function (id, on, label) {
      var host = $(id);
      M.clear(host);
      var b = M.switchBtn(on, label, function () {});
      state.switches[id] = b;
      host.appendChild(b);
    };
    sw('#ms-disappearing', s.allowDisappearing, T('admin.allow_disappearing'));
    sw('#ms-allow-stories', s.allowStories !== false, T('admin.allow_stories'));
    sw('#ms-allow-actions', s.allowActions !== false, T('admin.allow_actions'));
    sw('#ms-children-request', s.childrenMayRequest !== false, T('admin.children_request'));
    sw('#ms-d-receipts', s.defaults.readReceipts, T('prefs.read_receipts'));
    sw('#ms-d-typing', s.defaults.typing, T('prefs.typing'));
    sw('#ms-d-preview', s.defaults.preview, T('prefs.preview'));
    var m = r.media;
    if (m) {
      $('#ms-quota').textContent = M.bytes(m.quota);
      $('#ms-maxfile').textContent = M.bytes(m.maxBytes);
      $('#ms-types').textContent = String((m.types || []).length);
      var groups = {};
      (m.types || []).forEach(function (t) { var g = t.split('/')[0]; groups[g] = (groups[g] || 0) + 1; });
      $('#ms-types-list').textContent = Object.keys(groups).map(function (g) { return T('admin.type_' + g) + ' ' + groups[g]; }).join(' · ');
    }
  }

  var on = function (id) { return state.switches[id] && state.switches[id].getAttribute('aria-checked') === 'true'; };

  function save() {
    var btn = $('#ms-save');
    btn.disabled = true;
    $('#ms-saved').hidden = true;
    M.api('PUT', 'admin/settings', {
      retentionDays: Number($('#ms-retention').value), editWindowMin: Number($('#ms-edit').value), maxVoiceS: Number($('#ms-voice').value),
      allowDisappearing: on('#ms-disappearing'), allowStories: on('#ms-allow-stories'), allowActions: on('#ms-allow-actions'),
      requestTtlMin: Number($('#ms-req-ttl').value), requestApproversDefault: $('#ms-req-approvers').value, childrenMayRequest: on('#ms-children-request'),
      grantMaxDays: Number($('#ms-grant-max').value),
      defaults: { readReceipts: on('#ms-d-receipts'), typing: on('#ms-d-typing'), preview: on('#ms-d-preview') },
    }).then(function (r) {
      renderSettings(r);
      $('#ms-saved').hidden = false;
      setTimeout(function () { $('#ms-saved').hidden = true; }, 3000);
    }).catch(M.warn).then(function () { btn.disabled = false; });
  }

  // ── 1.9.0: group chats for GateControl groups (GateControl ≥ 1.200.0; GC.pickPrincipals, else a select) ──
  var gcState = null;
  function gcNote(lines) { var n = $('#ms-gc-note'); n.hidden = !lines.length; n.textContent = lines.join(' '); }
  function gcStatus(it) {
    if (it.gone) return { text: T('admin.gc_pending'), bad: false };
    if (it.error === 'family') return { text: T('admin.gc_family'), bad: false };
    if (it.error === 'too_many') return { text: T('admin.gc_too_many'), bad: true };
    if (it.error) return { text: T('admin.gc_error', { code: it.error }), bad: true };
    if (!it.ok) return { text: T('admin.gc_pending'), bad: false };
    return { text: [it.members != null ? T('admin.gc_members', { n: it.members }) : null, it.syncedAt ? T('admin.gc_synced', { when: M.when(it.syncedAt) }) : null].filter(Boolean).join(' · '), bad: false };
  }
  function renderGc(g) {
    gcState = g;
    $('#ms-gc-off').hidden = !!g.available;
    var list = M.clear($('#ms-gc-list'));
    var add = M.clear($('#ms-gc-add'));
    if (!g.available) return;
    if (!g.selected.length) list.appendChild(el('li', { class: 'ms-muted', text: T('admin.gc_none') }));
    g.selected.forEach(function (it) {
      var st = gcStatus(it);
      var path = it.path || ('#' + it.id);
      list.appendChild(el('li', null, [
        el('span', { class: 'ms-gc-path' }, [el('span', { text: path }), el('small', { class: st.bad ? 'is-bad' : null, text: st.text })]),
        el('button', { type: 'button', class: 'btn btn-sm', 'aria-label': T('admin.gc_remove', { path: path }), title: T('admin.gc_remove', { path: path }), on: { click: function () { removeGc(it, path); } } }, [M.icon('close', 14)]),
      ]));
    });
    var full = g.selected.length >= g.max;
    var chosen = g.selected.map(function (x) { return x.id; });
    if (window.GC && typeof window.GC.pickPrincipals === 'function') {
      add.appendChild(el('button', { type: 'button', class: 'btn', text: T('admin.gc_pick'), disabled: full, on: { click: pickGc } }));
    } else {
      // an older GateControl without the picker: a select fed by gc.groups.list (the family left out)
      var opts = g.options.filter(function (o) { return !o.family && chosen.indexOf(o.id) < 0; });
      var sel = el('select', { class: 'form-select', 'aria-label': T('admin.gc_choose') }, [el('option', { value: '', text: T('admin.gc_choose') })].concat(opts.map(function (o) { return el('option', { value: String(o.id), text: o.path }); })));
      add.appendChild(sel);
      add.appendChild(el('button', { type: 'button', class: 'btn', text: T('admin.gc_add'), disabled: full || !opts.length, on: { click: function () { if (sel.value) saveGc(chosen.concat([Number(sel.value)])); } } }));
    }
  }
  function saveGc(ids) {
    return M.api('PUT', 'admin/group-chats', { groupIds: ids }).then(function (r) {
      var g = r.groupChats;
      renderGc(g);
      gcNote((g.skipped || []).map(function (x) { return T(x.reason === 'family' ? 'admin.gc_skipped_family' : 'admin.gc_skipped_archived', { path: x.path }); }));
      M.toast(T('admin.gc_saved'));
    }).catch(M.warn);
  }
  function pickGc() {
    window.GC.pickPrincipals({ groups: true, users: false, multiple: true, title: T('admin.gc_pick_title') }).then(function (picked) {
      if (!picked || !picked.length || !gcState) return;
      var ids = gcState.selected.map(function (x) { return x.id; });
      picked.forEach(function (p) { if (p && p.type === 'group' && ids.indexOf(p.id) < 0) ids.push(p.id); });
      saveGc(ids.slice(0, gcState.max));
    });
  }
  function removeGc(it, path) {
    M.confirm(T('admin.gc_remove_confirm', { path: path }), T('common.ok'), true).then(function (ok) {
      if (!ok) return;
      saveGc(gcState.selected.filter(function (x) { return x.id !== it.id; }).map(function (x) { return x.id; }));
    });
  }

  // ── 1.12.0: bridges to other messengers (a GateControl that offers gc.bridges; hidden otherwise) ──
  var brBusy = false;
  function brState(n) {
    // 1.13.0: runs, but with another image than GateControl pins; 1.17.0: or WhatsApp turned its version away
    if (n.state === 'running' && (n.outdated || n.clientOutdated)) return { text: T('admin.br_state_outdated'), cls: ' is-limit' };
    if (n.state === 'running') return { text: T('admin.br_state_running'), cls: '' };
    if (n.state === 'starting') return { text: T('admin.br_state_starting'), cls: ' is-limit' };
    if (n.state === 'failed') return { text: T('admin.br_state_failed'), cls: ' is-error' };
    return { text: T('admin.br_state_off'), cls: ' is-off' };
  }
  function brNote(b) {
    var h = b.host || {};
    if (!b.enabled) return null;
    // 1.14.0: the main switch alone starts no bridge — say so instead of "starting …"
    if (!(b.networks || []).some(function (n) { return n.enabled; })) return T('admin.br_need_network');
    if (h.error === 'compose_missing') return T('admin.br_err_compose');
    // 1.23.0 (update.sh marker 10): the docker-compose.yml on the server has no service for a bridge switched on (Signal)
    var noCompose = (b.networks || []).filter(function (n) { return n.enabled && n.needs === 'compose'; })[0];
    if (noCompose) return T('admin.br_err_compose_net', { name: T('admin.br_net_' + noCompose.id) });
    var noScript = (b.networks || []).filter(function (n) { return n.enabled && n.needs === 'script'; })[0];
    if (noScript) return T('admin.br_err_script', { have: h.script && h.script.host != null ? h.script.host : '?', need: noScript.scriptNeeded || '?' });
    if (h.error === 'config_missing') return T('admin.br_err_config');
    if (h.error === 'start_failed') return T('admin.br_err_start');
    if (h.script && h.script.host != null && h.script.host < h.script.needed) return T('admin.br_err_script', { have: h.script.host, need: h.script.needed });
    if (h.state !== 'running') return T('admin.br_starting_hint');
    // 1.17.0: WhatsApp itself refuses the bridge's version — only a GateControl update with a newer pin helps
    var refused = (b.networks || []).filter(function (n) { return n.clientOutdated; })[0];
    if (refused) return T('admin.br_client_outdated', { name: T('admin.br_net_' + refused.id) });
    var old = (b.networks || []).filter(function (n) { return n.state === 'running' && n.outdated; })[0] || (h.homeserver && h.homeserver.running && h.homeserver.outdated ? h.homeserver : null);
    // 1.17.0 (update.sh marker 8): the script takes the pin of this GateControl at its next run
    if (old) return T(h.script && h.script.host != null && h.script.host >= 8 ? 'admin.br_outdated_pin' : 'admin.br_outdated', { have: old.version || '?', want: old.wantVersion || '?' });
    // 1.14.0: the way of the messages (GateControl with gc.bridges version 3: status().messages)
    if (!b.messages) return T('admin.br_need_server');
    if (b.messages.relay === 'missing') return T('admin.br_err_relay');
    if (b.messages.relay === 'stopped') return T('admin.br_relay_stopped');
    return null;
  }
  /** 1.14.0: when the bridges last delivered something and what waits to be filed — numbers only. */
  function brFlow(b) {
    var m = b.messages;
    if (!b.enabled || !m || !(b.networks || []).some(function (n) { return n.state === 'running'; })) return null;
    if (!m.lastEventAt) return T('admin.br_flow_none');
    return T('admin.br_flow', { time: new Date(m.lastEventAt).toLocaleString(M.LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }), pending: m.pending || 0 });
  }
  // 1.13.0: what `update.sh bridges-probe` measured on the server (numbers only), or how to measure — the limits in
  // docker-compose.yml are upper bounds nobody measured yet, so no need is claimed here
  function brProbe(b) {
    var h = b.host || {};
    if (!b.enabled || !h.limitsProvisional) return null;
    var p = h.probe;
    if (!p) return T('admin.br_limits');
    var date = new Date(p.at).toLocaleString(M.LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    if (p.result !== 'ok') return T('admin.br_probe_failed', { date: date, result: p.result || '?' });
    var label = function (k) { return k === 'hs' ? T('admin.br_probe_hs') : (/-relay$/.test(k) ? T('admin.br_probe_relay') : T('admin.br_net_' + k)); };
    var rows = Object.keys(p.services || {}).map(function (k) {
      var x = p.services[k];
      if (!x.running || x.memMb == null) return T('admin.br_probe_row_down', { name: label(k) });
      return T('admin.br_probe_row', { name: label(k), mem: x.memMb, peak: x.memPeakMb != null ? x.memPeakMb : x.memMb, written: x.writtenKb != null ? M.bytes(x.writtenKb * 1024) : '?' });
    });
    return T('admin.br_probe', { date: date, seconds: p.windowSeconds || '?', rows: rows.join(' · ') });
  }
  function gb(mb) { return (Math.round(mb / 102.4) / 10).toLocaleString(M.LOCALE) + ' GB'; }
  function setBr(patch) {
    if (brBusy) return;
    brBusy = true;
    M.api('PUT', 'admin/bridges', patch).then(function (r) { brBusy = false; renderBr(r.bridges); M.toast(T('common.saved')); })
      .catch(function (e) { brBusy = false; M.warn(e); M.api('GET', 'admin/bridges').then(function (r) { renderBr(r.bridges); }).catch(function () {}); });
  }
  function renderBr(b) {
    var card = $('#ms-br');
    card.hidden = !(b && b.available);
    if (card.hidden) return;
    var sw = M.clear($('#ms-br-on'));
    sw.appendChild(M.switchBtn(b.enabled, T('admin.br_on'), function (v) { setBr({ enabled: v }); }));
    var places = M.clear($('#ms-br-places'));
    (b.locations || []).forEach(function (p) {
      places.appendChild(el('li', null, [
        el('span', { class: 'ms-radio' + (p.id === b.location ? ' is-on' : ''), 'aria-hidden': 'true' }),
        el('span', { class: 'ms-gc-path' }, [el('span', { text: T('admin.br_place_' + p.kind) }), el('small', { text: T('admin.br_place_sub', { cores: p.cores, mem: gb(p.memMb), free: gb(p.freeMb) }) })]),
        p.id === b.location ? el('span', { class: 'ms-pill', text: T('admin.br_place_here') }) : null,
      ]));
    });
    $('#ms-br-data').textContent = T('admin.br_place_' + (b.location === 'server' ? 'server' : 'gateway'));
    var list = M.clear($('#ms-br-list'));
    (b.networks || []).forEach(function (n) {
      var st = brState(n);
      var sub = [];
      if (n.version) sub.push(n.version);
      if (n.memMb != null) sub.push(n.limitMb ? T('admin.br_mem_of', { mem: n.memMb, limit: n.limitMb }) : T('admin.br_mem', { mem: n.memMb }));
      sub.push(T(n.linked === 1 ? 'admin.br_linked_one' : 'admin.br_linked', { n: n.linked || 0 }));
      // 1.17.0: how many of them got the bridge's phone warning (no names)
      if (n.phoneOffline) sub.push(T(n.phoneOffline === 1 ? 'admin.br_phone_one' : 'admin.br_phone', { n: n.phoneOffline }));
      // 1.24.0: Telegram starts only with the administrator's application id
      var noApp = n.id === 'telegram' && b.telegramApp && !b.telegramApp.set;
      if (noApp) sub.unshift(T('admin.br_tg_missing_sub'));
      // 1.23.0: what this bridge still waits for on the server
      if (n.enabled && n.needs && n.needs !== 'app') sub.push(T('admin.br_needs_' + n.needs));
      list.appendChild(el('li', null, [
        M.netLogo(n.id, null, 18, 'ms-br-mark'),
        el('span', { class: 'ms-gc-path' }, [el('span', { text: T('admin.br_net_' + n.id) }), el('small', { text: sub.join(' · ') })]),
        noApp ? el('span', { class: 'ms-pill is-limit', text: T('admin.br_needs_app') }) : null,
        el('span', { class: 'ms-pill' + st.cls, text: st.text }),
        noApp ? el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: T('admin.br_tg_setup'), on: { click: function () { tgForm(true); } } }) : null,
        M.switchBtn(n.enabled, T('admin.br_net_' + n.id), function (v) { var nets = {}; nets[n.id] = v; setBr({ networks: nets }); }, !b.enabled),
      ]));
      // 1.24.0: the application id is there — when and by whom, never its content
      if (n.id === 'telegram' && b.telegramApp && b.telegramApp.set) {
        list.appendChild(el('li', { id: 'ms-br-tg-app' }, [
          el('span', { class: 'ms-gc-path' }, [el('span', { text: T('admin.br_tg_app') }), el('small', { text: T('admin.br_tg_saved', { date: b.telegramApp.setAt ? new Date(b.telegramApp.setAt).toLocaleDateString(M.LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '?', name: b.telegramApp.setBy || '?' }) })]),
          el('button', { type: 'button', class: 'btn btn-sm', text: T('admin.br_tg_renew'), on: { click: function () { tgForm(true); } } }),
          el('button', { type: 'button', class: 'btn btn-sm', text: T('admin.br_tg_remove'), on: { click: tgRemove } }),
        ]));
      }
    });
    if (!b.telegramApp) tgForm(false);
    // 1.23.0 (gc.bridges version 10): one switch for every bridge that converts animated stickers — off: a still picture
    if (b.stickers && typeof b.stickers.animated === 'boolean') {
      list.appendChild(el('li', { id: 'ms-br-stickers' }, [
        el('span', { class: 'ms-gc-path' }, [el('span', { text: T('admin.br_stickers') }), el('small', { text: T(b.stickers.animated ? 'admin.br_stickers_on' : 'admin.br_stickers_off') })]),
        M.switchBtn(b.stickers.animated, T('admin.br_stickers'), function (v) { setBr({ animatedStickers: v }); }, !b.enabled),
      ]));
    }
    var hs = b.host && b.host.homeserver;
    if (b.enabled && hs && hs.running && hs.memMb != null) {
      list.appendChild(el('li', null, [el('span', { class: 'ms-gc-path' }, [el('span', { text: T('admin.br_hs') }),
        el('small', { text: [hs.version, hs.limitMb ? T('admin.br_mem_of', { mem: hs.memMb, limit: hs.limitMb }) : T('admin.br_mem', { mem: hs.memMb })].filter(Boolean).join(' · ') })])]));
    }
    var note = brNote(b);
    var n = $('#ms-br-note');
    n.hidden = !note;
    n.textContent = note || '';
    var flow = brFlow(b);
    var f = $('#ms-br-flow');
    f.hidden = !flow;
    f.textContent = flow || '';
    var probe = brProbe(b);
    var pr = $('#ms-br-probe');
    pr.hidden = !probe;
    pr.textContent = probe || '';
    renderBr17(b);
    // 1.16.0: a new chat by number — how many numbers a person may check per hour (only while GateControl can)
    var nc = b.newChat;
    $('#ms-br-nc').hidden = !(nc && nc.available);
    if (nc && nc.available && document.activeElement !== $('#ms-br-nc-in')) $('#ms-br-nc-in').value = String(nc.perHour);
  }
  // ── 1.24.0: „Telegram einrichten“ — the administrator's Telegram application id, passed straight to GateControl ──
  /** Show (or hide) the form. The values are only in the two fields until „Speichern und starten“, never kept here. */
  function tgForm(show) {
    var box = M.clear($('#ms-br-tg'));
    box.hidden = !show;
    if (!show) return;
    var id = el('input', { type: 'text', class: 'form-input', id: 'ms-br-tg-id', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', maxlength: '10', placeholder: '12345678' });
    var hash = el('input', { type: 'password', class: 'form-input', id: 'ms-br-tg-hash', autocomplete: 'off', spellcheck: 'false', maxlength: '32' });
    var idHint = el('small', { text: T('admin.br_tg_id_hint') });
    var hashHint = el('small', { text: T('admin.br_tg_hash_hint') });
    var save = el('button', { type: 'button', class: 'btn btn-primary', text: T('admin.br_tg_save') });
    var close = function () { id.value = ''; hash.value = ''; tgForm(false); };
    save.addEventListener('click', function () {
      var v = id.value.trim();
      var h = hash.value.trim();
      var okId = /^[1-9][0-9]{4,9}$/.test(v);
      var okHash = /^[0-9A-Fa-f]{32}$/.test(h);
      idHint.classList.toggle('is-bad', !okId);
      hashHint.classList.toggle('is-bad', !okHash);
      if (!okId) { id.focus(); return; }
      if (!okHash) { hash.focus(); return; }
      if (brBusy) return;
      brBusy = true;
      save.disabled = true;
      // the fields are emptied at once: the values live only in this one request
      id.value = ''; hash.value = '';
      M.api('PUT', 'admin/bridges', { telegramApp: { apiId: v, apiHash: h } }).then(function (r) { brBusy = false; tgForm(false); renderBr(r.bridges); M.toast(T('common.saved')); })
        .catch(function (e) { brBusy = false; save.disabled = false; M.warn(e); });
    });
    box.appendChild(el('h4', { text: T('admin.br_tg_title') }));
    box.appendChild(el('p', { text: T('admin.br_tg_lead') }));
    box.appendChild(el('ol', null, ['admin.br_tg_step1', 'admin.br_tg_step2', 'admin.br_tg_step3'].map(function (k) { return el('li', { text: T(k) }); })));
    box.appendChild(el('label', { class: 'ms-br-tg-f', for: 'ms-br-tg-id' }, [el('span', { text: 'api_id' }), id, idHint]));
    box.appendChild(el('label', { class: 'ms-br-tg-f', for: 'ms-br-tg-hash' }, [el('span', { text: 'api_hash' }), hash, hashHint]));
    box.appendChild(el('p', { class: 'ms-gc-note', text: T('admin.br_tg_note') }));
    box.appendChild(el('div', { class: 'ms-br-tg-bar' }, [el('button', { type: 'button', class: 'btn', text: T('common.cancel'), on: { click: close } }), save]));
    setTimeout(function () { id.focus(); }, 30);
  }
  function tgRemove() {
    M.confirm(T('admin.br_tg_remove_confirm'), T('admin.br_tg_remove'), true).then(function (ok) { if (ok) setBr({ telegramApp: null }); });
  }

  // ── 1.17.0: where the files lie, the nightly snapshot, older messages, the clean-up at the homeserver ──
  function fmtDate(iso) { return new Date(iso).toLocaleString(M.LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  function renderBr17(b) {
    var md = b.media;
    $('#ms-br-media').hidden = !md;
    if (md) {
      $('#ms-br-media-v').textContent = md.target && md.target.kind !== 'server' ? (md.target.label || T('admin.br_media_target')) : T('admin.br_place_server');
      var ms = [T('admin.br_media_sub', { size: M.bytes(md.bytes || 0), n: md.count || 0 })];
      if (md.moving) ms.push(T('admin.br_media_moving', { done: md.moving.done, total: md.moving.total }));
      else if (md.state === 'unreachable') ms.push(T('admin.br_media_unreachable'));
      ms.push(T('admin.br_media_hint'));
      $('#ms-br-media-sub').textContent = ms.join(' · ');
    }
    var bk = b.backup;
    $('#ms-br-bk').hidden = !bk;
    if (bk) {
      var bs = [T('admin.br_bk_sub', { time: bk.time })];
      if (bk.lastAt) bs.push(T('admin.br_bk_last', { date: fmtDate(bk.lastAt), size: bk.bytes != null ? M.bytes(bk.bytes) : '?' }));
      else bs.push(T('admin.br_bk_never'));
      if (bk.error) bs.push(T('admin.br_bk_error'));
      if (bk.restore && bk.restore.state === 'waiting') bs.push(T('admin.br_bk_restoring'));
      $('#ms-br-bk-sub').textContent = bs.join(' · ');
      var v = M.clear($('#ms-br-bk-v'));
      v.className = 'ms-br-bkv';
      if (bk.requested) v.appendChild(el('span', { class: 'ms-pill is-limit', text: T('admin.br_bk_requested') }));
      v.appendChild(el('button', { type: 'button', class: 'btn btn-sm', id: 'ms-br-bk-now', text: T('admin.br_bk_now'), disabled: !!bk.requested || !b.enabled,
        on: { click: function () { setBr({ backupNow: true }); } } }));
    }
    var hs = b.history || {};
    $('#ms-br-hist').hidden = !hs.available;
    // with older history (gc.bridges version 5) the note under „Wo laufen die Brücken?“ says how the server spares its disk
    if (hs.available) $('#ms-br-place-note').textContent = T('admin.br_place_note_hist');
    if (hs.available) {
      var sw = M.clear($('#ms-br-hist-on'));
      sw.appendChild(M.switchBtn(hs.enabled !== false, T('admin.br_hist_on'), function (on) { setBr({ history: on }); }, !b.enabled));
      $('#ms-br-hist-sub').textContent = T('admin.br_hist_sub', { conv: hs.conversations || 30, msgs: hs.messages || 200 });
      $('#ms-br-hist-win').hidden = hs.enabled === false;
      if (document.activeElement !== $('#ms-br-hist-from')) $('#ms-br-hist-from').value = hs.from || '01:00';
      if (document.activeElement !== $('#ms-br-hist-to')) $('#ms-br-hist-to').value = hs.to || '05:00';
      var hn = $('#ms-br-hist-note');
      var text = hs.enabled === false ? null : (hs.pending > 0 ? T('admin.br_hist_pending', { n: hs.pending, from: hs.from, to: hs.to }) : T('admin.br_hist_disk'));
      hn.hidden = !text;
      hn.textContent = text || '';
    }
    var cl = b.cleanup;
    var cn = $('#ms-br-clean');
    var ct = !cl || !b.enabled ? null : (cl.error === 'no_admin' ? T('admin.br_clean_no_admin') : ((cl.deleted || cl.waiting) ? T('admin.br_clean', { deleted: cl.deleted || 0, waiting: cl.waiting || 0 }) : null));
    cn.hidden = !ct;
    cn.textContent = ct || '';
  }
  function histWindow() {
    var f = $('#ms-br-hist-from').value;
    var t = $('#ms-br-hist-to').value;
    if (!/^\d\d:\d\d$/.test(f) || !/^\d\d:\d\d$/.test(t)) { M.toast(T('error.invalid'), 'error'); return; }
    setBr({ historyFrom: f, historyTo: t });
  }
  $('#ms-br-hist-from').addEventListener('change', histWindow);
  $('#ms-br-hist-to').addEventListener('change', histWindow);
  $('#ms-br-nc-in').addEventListener('change', function (e) {
    var v = Number(e.target.value);
    if (!Number.isInteger(v) || v < 1 || v > 60) { M.toast(T('error.invalid'), 'error'); M.api('GET', 'admin/bridges').then(function (r) { renderBr(r.bridges); }).catch(function () {}); return; }
    setBr({ newChatPerHour: v });
  });

  function load() {
    M.api('GET', 'admin/overview').then(renderOverview).catch(M.warn);
    M.api('GET', 'admin/settings').then(renderSettings).catch(M.warn);
    M.api('GET', 'admin/group-chats').then(function (r) { renderGc(r.groupChats); }).catch(M.warn);
    M.api('GET', 'admin/bridges').then(function (r) { renderBr(r.bridges); }).catch(function () { $('#ms-br').hidden = true; });
  }

  $('#ms-save').addEventListener('click', save);
  var errs = $('#ms-errors');
  if (errs && window.GC && window.GC.navigate) {
    errs.parentNode.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('admin.open_log'), on: { click: function () { window.GC.navigate('log'); } } }));
  }
  load();
}());
