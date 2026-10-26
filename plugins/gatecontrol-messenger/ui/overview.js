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

  function load() {
    M.api('GET', 'admin/overview').then(renderOverview).catch(M.warn);
    M.api('GET', 'admin/settings').then(renderSettings).catch(M.warn);
    M.api('GET', 'admin/group-chats').then(function (r) { renderGc(r.groupChats); }).catch(M.warn);
  }

  $('#ms-save').addEventListener('click', save);
  var errs = $('#ms-errors');
  if (errs && window.GC && window.GC.navigate) {
    errs.parentNode.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('admin.open_log'), on: { click: function () { window.GC.navigate('log'); } } }));
  }
  load();
}());
