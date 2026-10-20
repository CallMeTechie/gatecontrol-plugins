/* The logbook (Fahrtenbuch): the admin page "logbook" and the portal section
   "logbook" — trips of a month, the purpose of each trip at one tap, editing,
   trips entered by hand (admin) and the export as PDF or CSV (GC.saveFile,
   GateControl ≥ 1.186.0). */
(function () {
  'use strict';
  var SK = window.SK;
  var T = SK.T, $ = SK.$, el = SK.el, clear = SK.clear, api = SK.api, toast = SK.toast;
  var CTX = SK.CTX;
  var PORTAL = CTX.view === 'portal';
  var BASE = PORTAL ? 'portal/logbook' : 'logbook';
  var PURPOSES = ['private', 'business', 'commute'];
  var state = { vehicleId: null, month: null, data: null, busy: false };

  function errText(e) { return (e && e.data && e.data.error) || (e && e.message) || T('error.generic'); }
  function purposeLabel(p) { return T(p ? 'logbook.purpose_' + p : 'logbook.purpose_open'); }
  function km(v) { return SK.fmtNum(v) + ' km'; }

  function monthLabel(ym) {
    var p = String(ym || '').split('-');
    var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, 1));
    try { return d.toLocaleDateString(SK.LOCALE, { month: 'long', year: 'numeric', timeZone: 'UTC' }); } catch (_) { return ym; }
  }
  function shiftMonth(ym, n) {
    var p = String(ym).split('-');
    var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1 + n, 1));
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }

  function canEdit() { return !!(state.data && state.data.canEdit); }
  function isAdmin() { return !!(state.data && state.data.admin); }

  function load() {
    var q = [];
    if (state.vehicleId) q.push('vehicle=' + encodeURIComponent(state.vehicleId));
    if (state.month) q.push('month=' + encodeURIComponent(state.month));
    return api('GET', BASE + (q.length ? '?' + q.join('&') : '')).then(function (r) {
      state.data = r;
      state.month = r.month;
      state.vehicleId = r.vehicleId;
      render();
    }, function (e) {
      clear($('#lb-list'));
      $('#lb-empty').hidden = false;
      $('#lb-empty').textContent = errText(e);
    });
  }

  function render() {
    var d = state.data;
    var sel = clear($('#lb-vehicle'));
    d.vehicles.forEach(function (v) {
      var name = v.name || v.model || v.vin;
      sel.appendChild(el('option', { value: String(v.id), text: v.model && v.model !== v.name && v.name ? name + ' · ' + v.model : name, selected: v.id === d.vehicleId }));
    });
    $('#lb-vehicle-wrap').hidden = d.vehicles.length < 2;
    $('#lb-month-label').textContent = monthLabel(d.month);
    $('#lb-next').disabled = d.month >= d.currentMonth;
    $('#lb-add').hidden = !isAdmin() || !d.vehicleId;
    $('#lb-export-open').disabled = !d.vehicleId;
    var hint = $('#lb-hint');
    hint.hidden = true;
    if (PORTAL && !d.canEdit) { hint.hidden = false; hint.textContent = T('logbook.login_hint'); }
    else if (d.moving) { hint.hidden = false; hint.textContent = T('widget.trip_moving'); }
    else if (d.detection && d.detection.waitingSince) { hint.hidden = false; hint.textContent = T('logbook.waiting_km', { since: SK.rel(d.detection.waitingSince) }); }
    var det = $('#lb-detection');
    det.hidden = !(d.detection && d.detection.km != null);
    det.textContent = det.hidden ? '' : T('logbook.last_km', { km: km(d.detection.km) });

    var s = d.summary;
    var sum = clear($('#lb-sum'));
    function stat(label, value, tone) {
      return el('div', { class: 'lb-stat', 'data-tone': tone || null }, [el('span', { class: 'lb-stat-l', text: label }), el('b', { text: value })]);
    }
    sum.appendChild(stat(T('logbook.sum_total'), km(s.total) + ' · ' + T('logbook.trips_n', { n: s.count })));
    sum.appendChild(stat(T('logbook.purpose_business'), km(s.business)));
    sum.appendChild(stat(T('logbook.purpose_private'), km(s.private)));
    sum.appendChild(stat(T('logbook.purpose_commute'), km(s.commute)));
    if (s.openCount) sum.appendChild(stat(T('logbook.purpose_open'), T('logbook.open_n', { n: s.openCount }), 'warn'));

    var list = clear($('#lb-list'));
    $('#lb-empty').hidden = d.trips.length > 0;
    $('#lb-empty').textContent = d.vehicles.length ? T('logbook.empty') : T('logbook.no_vehicles');
    d.trips.forEach(function (tr) { list.appendChild(tripCard(tr)); });
  }

  function tripCard(tr) {
    var route = [tr.startAddress || T('logbook.unknown_place'), tr.endAddress || T('logbook.unknown_place')];
    var seg = el('div', { class: 'lb-seg', role: 'group', 'aria-label': T('logbook.purpose') }, PURPOSES.map(function (p) {
      return el('button', {
        type: 'button', class: 'lb-seg-btn', 'data-p': p, 'aria-pressed': String(tr.purpose === p), disabled: !canEdit(), text: purposeLabel(p),
        on: { click: function () { setPurpose(tr, tr.purpose === p ? null : p); } },
      });
    }));
    var meta = [];
    if (tr.note) meta.push(el('span', { class: 'lb-note-txt', text: tr.note }));
    if (tr.driver) meta.push(el('span', { class: 'pt-tag', text: tr.driver.username }));
    if (tr.source === 'manual') meta.push(el('span', { class: 'pt-tag', text: T('logbook.manual') }));
    if (tr.edited) meta.push(el('span', { class: 'pt-tag', text: T('logbook.edited') }));
    return el('article', { class: 'lb-trip', 'data-open': tr.purpose ? null : 'true' }, [
      el('div', { class: 'lb-trip-head' }, [
        el('div', { class: 'lb-when' }, [el('b', { text: tr.dateLabel }), el('span', { class: 'muted', text: tr.startTime + '–' + tr.endTime })]),
        el('div', { class: 'lb-km' }, [el('b', { text: km(tr.distanceKm) }),
          tr.startKm != null ? el('span', { class: 'muted', text: SK.fmtNum(tr.startKm) + ' → ' + SK.fmtNum(tr.endKm) }) : null]),
      ]),
      el('div', { class: 'lb-route' }, [el('span', { text: route[0] }), el('span', { class: 'lb-arrow', 'aria-hidden': 'true', text: '→' }), el('span', { text: route[1] })]),
      el('div', { class: 'lb-trip-foot' }, [seg, el('div', { class: 'lb-meta' }, meta),
        canEdit() ? el('button', { type: 'button', class: 'btn btn-sm', text: T('logbook.edit'), on: { click: function () { openEdit(tr); } } }) : null]),
    ]);
  }

  function setPurpose(tr, purpose) {
    if (!canEdit() || state.busy) return;
    state.busy = true;
    api('PUT', BASE + '/trips/' + tr.id, { purpose: purpose }).then(function () { return load(); }, function (e) { toast(errText(e), 'error'); })
      .then(function () { state.busy = false; });
  }

  // ── edit ──
  var editing = null;
  function fillPurposes(select, value) {
    clear(select);
    select.appendChild(el('option', { value: '', text: T('logbook.purpose_open'), selected: !value }));
    PURPOSES.forEach(function (p) { select.appendChild(el('option', { value: p, text: purposeLabel(p), selected: value === p })); });
  }
  function fillDrivers(select, value) {
    clear(select);
    select.appendChild(el('option', { value: '', text: T('logbook.nobody'), selected: value == null }));
    (state.data.users || []).forEach(function (u) { select.appendChild(el('option', { value: String(u.id), text: u.username, selected: u.id === value })); });
  }
  function openEdit(tr) {
    editing = tr;
    $('#lb-e-summary').textContent = tr.dateLabel + ' · ' + tr.startTime + '–' + tr.endTime + ' · ' + km(tr.distanceKm);
    fillPurposes($('#lb-e-purpose'), tr.purpose);
    $('#lb-e-note').value = tr.note || '';
    $('#lb-e-driver-wrap').hidden = !isAdmin();
    if (isAdmin()) fillDrivers($('#lb-e-driver'), tr.driverUserId);
    $('#lb-e-delete').hidden = !isAdmin();
    SK.openModal('lb-edit-modal');
  }
  $('#lb-e-save').addEventListener('click', function () {
    if (!editing) return;
    var body = { purpose: $('#lb-e-purpose').value || null, note: $('#lb-e-note').value };
    if (isAdmin()) body.driverUserId = $('#lb-e-driver').value ? Number($('#lb-e-driver').value) : null;
    api('PUT', BASE + '/trips/' + editing.id, body).then(function () {
      SK.closeModal('lb-edit-modal');
      toast(T('common.saved'));
      return load();
    }, function (e) { toast(errText(e), 'error'); });
  });
  $('#lb-e-delete').addEventListener('click', function () {
    if (!editing) return;
    var tr = editing;
    SK.confirm({ title: T('logbook.delete'), message: T('logbook.delete_confirm', { date: tr.dateLabel, km: SK.fmtNum(tr.distanceKm) }), danger: true, okLabel: T('logbook.delete') }).then(function (yes) {
      if (!yes) return null;
      return api('DELETE', BASE + '/trips/' + tr.id).then(function () { SK.closeModal('lb-edit-modal'); return load(); }, function (e) { toast(errText(e), 'error'); });
    });
  });

  // ── add by hand (admin) ──
  $('#lb-add').addEventListener('click', function () {
    var today = new Date();
    $('#lb-a-date').value = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    ['#lb-a-start', '#lb-a-end', '#lb-a-km1', '#lb-a-km2', '#lb-a-from', '#lb-a-to', '#lb-a-note'].forEach(function (s) { $(s).value = ''; });
    fillPurposes($('#lb-a-purpose'), null);
    fillDrivers($('#lb-a-driver'), null);
    $('#lb-a-msg').textContent = '';
    SK.openModal('lb-add-modal');
  });
  $('#lb-a-save').addEventListener('click', function () {
    var n = function (s) { var v = $(s).value; return v === '' ? null : Number(v); };
    var body = {
      vehicleId: state.vehicleId, date: $('#lb-a-date').value, startTime: $('#lb-a-start').value, endTime: $('#lb-a-end').value,
      startKm: n('#lb-a-km1'), endKm: n('#lb-a-km2'), startAddress: $('#lb-a-from').value, endAddress: $('#lb-a-to').value,
      purpose: $('#lb-a-purpose').value || null, note: $('#lb-a-note').value, driverUserId: $('#lb-a-driver').value ? Number($('#lb-a-driver').value) : null,
    };
    api('POST', BASE + '/trips', body).then(function () {
      SK.closeModal('lb-add-modal');
      toast(T('common.saved'));
      state.month = body.date.slice(0, 7);
      return load();
    }, function (e) { $('#lb-a-msg').textContent = errText(e); });
  });

  // ── export ──
  $('#lb-export-open').addEventListener('click', function () {
    $('#lb-x-from').value = state.month;
    $('#lb-x-to').value = state.month;
    SK.openModal('lb-export-modal');
  });
  function b64ToBlob(b64, type) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type });
  }
  $('#lb-x-go').addEventListener('click', function () {
    var btn = $('#lb-x-go');
    var fmt = (document.querySelector('input[name="lb-x-format"]:checked') || {}).value || 'pdf';
    var from = $('#lb-x-from').value || state.month;
    var to = $('#lb-x-to').value || from;
    if (to < from) { var x = from; from = to; to = x; }
    if (!window.GC || typeof window.GC.saveFile !== 'function') { toast(T('logbook.needs_update'), 'error'); return; }
    btn.disabled = true;
    api('GET', BASE + '/export?vehicle=' + encodeURIComponent(state.vehicleId) + '&from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to) + '&format=' + fmt)
      .then(function (r) {
        var f = r && r.file;
        if (!f || typeof f.data !== 'string') throw new Error(T('error.generic'));
        return window.GC.saveFile(b64ToBlob(f.data, f.type), f.name);
      })
      .then(function () { SK.closeModal('lb-export-modal'); toast(T('logbook.exported')); }, function (e) { toast(errText(e), 'error'); })
      .then(function () { btn.disabled = false; });
  });

  // ── navigation ──
  $('#lb-vehicle').addEventListener('change', function (e) { state.vehicleId = Number(e.target.value) || null; load(); });
  $('#lb-prev').addEventListener('click', function () { state.month = shiftMonth(state.month, -1); load(); });
  $('#lb-next').addEventListener('click', function () { state.month = shiftMonth(state.month, 1); load(); });

  load();
}());
