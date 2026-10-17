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
  }

  function renderSettings(r) {
    state.settings = r.settings;
    state.options = r.options;
    var s = r.settings;
    option($('#ms-retention'), r.options.retentionDays, retentionLabel, s.retentionDays);
    option($('#ms-edit'), r.options.editWindowMin, editLabel, s.editWindowMin);
    option($('#ms-voice'), r.options.maxVoiceS, voiceLabel, s.maxVoiceS);
    var sw = function (id, on, label) {
      var host = $(id);
      M.clear(host);
      var b = M.switchBtn(on, label, function () {});
      state.switches[id] = b;
      host.appendChild(b);
    };
    sw('#ms-disappearing', s.allowDisappearing, T('admin.allow_disappearing'));
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
      allowDisappearing: on('#ms-disappearing'),
      defaults: { readReceipts: on('#ms-d-receipts'), typing: on('#ms-d-typing'), preview: on('#ms-d-preview') },
    }).then(function (r) {
      renderSettings(r);
      $('#ms-saved').hidden = false;
      setTimeout(function () { $('#ms-saved').hidden = true; }, 3000);
    }).catch(M.warn).then(function () { btn.disabled = false; });
  }

  function load() {
    M.api('GET', 'admin/overview').then(renderOverview).catch(M.warn);
    M.api('GET', 'admin/settings').then(renderSettings).catch(M.warn);
  }

  $('#ms-save').addEventListener('click', save);
  var errs = $('#ms-errors');
  if (errs && window.GC && window.GC.navigate) {
    errs.parentNode.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: T('admin.open_log'), on: { click: function () { window.GC.navigate('log'); } } }));
  }
  load();
}());
