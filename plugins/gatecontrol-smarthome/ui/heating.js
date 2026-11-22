/* The page "Heizung" (1.14.0, administrators): overview (rooms, plans, presets), "Heizung abwesend", holiday, the
   weekly plan editor and the room page (ui/heatui.js). */
(function () {
  'use strict';
  var S = window.SH, H = window.SHH, T = S.T, $ = S.$, $$ = S.$$, el = S.el;
  var PRESETS = H.PRESETS;
  var DAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
  var data = null;
  var view = 'rooms';
  var roomId = null;
  var editor = null; // { id, week, sel: { d, i } }

  function warn(e) { S.toast((e && e.message) || T('common.error'), 'error'); }
  function dayName(d) { return T('heat.ui.day_' + DAYS[d]); }
  function parseHm(s) { var m = /^(\d{2}):(\d{2})/.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
  function grid(min) { return Math.max(0, Math.min(1440, Math.round(min / 15) * 15)); }
  function setSwitch(b, on) { b.classList.toggle('on', !!on); b.setAttribute('aria-checked', on ? 'true' : 'false'); }

  // ─── Overview ──────────────────────────────────
  function load() {
    return S.api('GET', 'heating').then(function (d) { data = d; render(); }, warn);
  }
  function render() {
    if (!data) return;
    setSwitch($('#ht-away'), data.house.away);
    renderBanner();
    if (roomId != null) {
      var v = data.rooms.filter(function (r) { return r.id === roomId; })[0];
      if (v) { showRoom(v); return; }
      roomId = null;
    }
    $('#ht-room').hidden = true;
    $('#ht-overview').hidden = false;
    $('#ht-toolbar').hidden = false;
    $('#ht-rooms-sec').hidden = view !== 'rooms';
    $('#ht-plans-sec').hidden = view === 'presets';
    $('#ht-presets-sec').hidden = view !== 'presets';
    $$('#ht-seg button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-v') === view ? 'true' : 'false'); });
    var n = data.rooms.reduce(function (a, r) { return a + r.thermostats.length; }, 0);
    $('#ht-rooms-sub').textContent = T('heat.ui.rooms_sub', { rooms: data.rooms.length, n: n, at: H.clock(data.now) });
    var rooms = S.clear($('#ht-rooms'));
    data.rooms.forEach(function (v) { rooms.appendChild(H.roomCard(v, data.now, openRoom)); });
    $('#ht-empty').hidden = data.rooms.length > 0;
    $('#ht-plans-sub').textContent = String(data.plans.length);
    var plans = S.clear($('#ht-plans'));
    data.plans.forEach(function (p) {
      var rn = p.rooms.map(function (r) { return r.name; }).join(', ') || T('heat.ui.no_rooms');
      var own = PRESETS.filter(function (k) { return p.presets[k] != null; }).map(function (k) { return H.pname(k) + ' ' + H.deg(p.presets[k]); });
      plans.appendChild(el('div', { class: 'sh-card ht-plan' }, [
        el('div', { class: 'h' }, [el('span', { text: p.name }), el('button', { type: 'button', class: 'btn btn-sm', text: T('heat.ui.edit'), 'aria-label': T('heat.ui.edit_plan', { name: p.name }), on: { click: function () { openEditor(p.id); } } })]),
        el('small', { text: [rn].concat(own).join(' · ') }),
        H.bar(p.today, { thin: true, now: nowMin(), label: T('heat.ui.today_of', { name: p.name }) }),
      ]));
    });
    if (!data.plans.length) plans.appendChild(el('p', { class: 'ht-empty', text: T('heat.ui.no_plans') }));
    renderPresets();
  }
  function nowMin() { var d = new Date(data.now); return d.getHours() * 60 + d.getMinutes(); }

  function renderBanner() {
    var host = S.clear($('#ht-banner'));
    var v = data.house.vacation;
    if (!v) return;
    var from = Date.parse(v.from), to = Date.parse(v.to), resume = Date.parse(v.resume_at);
    var special = Object.keys(v.rooms || {}).map(function (id) {
      var r = data.rooms.filter(function (x) { return String(x.id) === id; })[0];
      return r ? r.name + ' ' + H.pname(v.rooms[id]) : null;
    }).filter(Boolean);
    var text = T('heat.ui.vacation_banner', { preset: H.pname(v.preset), resume: H.day(resume) + ' ' + H.clock(resume), back: H.clock(to) }) + (special.length ? ' ' + T('heat.ui.vacation_special', { list: special.join(', ') }) : '');
    host.appendChild(el('div', { class: 'ht-banner', role: 'status' }, [H.icon('leaf', 18), el('span', null, [el('b', { text: T('heat.ui.vacation_title', { from: H.day(from), to: H.day(to) }) }), ' ' + text]),
      el('span', { class: 'sh-spacer' }), el('button', { type: 'button', class: 'btn btn-sm', text: T('heat.ui.change'), on: { click: openVacation } })]));
  }

  function presetInputs(host, values, placeholders, idPrefix) {
    S.clear(host);
    PRESETS.forEach(function (p) {
      var input = el('input', { class: 'form-input', type: 'number', min: '5', max: '30', step: '0.5', id: idPrefix + p, value: values[p] == null ? '' : String(values[p]), placeholder: placeholders ? String(placeholders[p]).replace('.', S.CTX.lang === 'en' ? '.' : ',') : null });
      host.appendChild(el('label', { class: 'pc-' + p }, [el('span', null, [el('i', { class: 'ht-dot' }), H.pname(p)]), input]));
    });
  }
  function readPresets(idPrefix, required) {
    var out = {};
    for (var i = 0; i < PRESETS.length; i++) {
      var p = PRESETS[i];
      var raw = $('#' + idPrefix + p).value.trim().replace(',', '.');
      if (!raw) { if (required) return null; continue; }
      var n = Number(raw);
      if (!isFinite(n) || n < 5 || n > 30) return null;
      out[p] = Math.round(n * 2) / 2;
    }
    return out;
  }
  function renderPresets() {
    presetInputs($('#ht-house-presets'), data.house.presets, null, 'ht-hp-');
    var body = S.clear($('#ht-room-presets'));
    data.rooms.forEach(function (v) {
      var own = PRESETS.filter(function (k) { return v.own_presets[k] != null; }).map(function (k) { return H.pname(k) + ' ' + H.deg(v.own_presets[k]); }).join(', ') || '–';
      var tr = el('tr', null, [el('td', { text: v.name }), el('td', { text: own }), el('td', { text: v.max_setpoint == null ? '–' : H.deg(v.max_setpoint) }),
        el('td', null, [el('button', { type: 'button', class: 'btn btn-sm', text: T('heat.ui.edit'), 'aria-label': T('heat.ui.room_settings_of', { name: v.name }), on: { click: function (e) { e.stopPropagation(); openRoomSettings(v); } } })])]);
      body.appendChild(tr);
    });
  }
  $('#ht-house-save').addEventListener('click', function () {
    var p = readPresets('ht-hp-', true);
    if (!p) { S.toast(T('heat.ui.temps_invalid'), 'error'); return; }
    S.api('PUT', 'heating/house', { presets: p }).then(function () { S.toast(T('heat.ui.saved')); load(); }, warn);
  });
  $('#ht-seg').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    view = b.getAttribute('data-v');
    render();
  });
  $('#ht-away').addEventListener('click', function () {
    var on = !data.house.away;
    S.api('PUT', 'heating/house', { away: on }).then(function () { S.toast(T(on ? 'heat.away_done_on' : 'heat.away_done_off')); load(); }, warn);
  });

  // ─── Room page ─────────────────────────────────
  function openRoom(id) { roomId = id; render(); try { window.scrollTo(0, 0); } catch (_) { /* old browser */ } }
  function showRoom(v) {
    $('#ht-overview').hidden = true;
    $('#ht-toolbar').hidden = true;
    var host = $('#ht-room');
    host.hidden = false;
    H.roomPage({ host: host, view: v, now: data.now, admin: true, base: 'heating',
      back: function () { roomId = null; load(); },
      openPlan: function (pid, rid) { openEditor(pid, rid); },
      planRooms: function (pid) { var p = data.plans.filter(function (x) { return x.id === pid; })[0]; return p ? p.rooms.map(function (r) { return r.name; }).join(', ') : ''; },
      roomSettings: openRoomSettings });
  }

  // ─── Room settings ─────────────────────────────
  var settingsFor = null;
  function openRoomSettings(v) {
    settingsFor = v;
    $('#ht-r-title').textContent = T('heat.ui.room_settings_of', { name: v.name });
    presetInputs($('#ht-r-presets'), v.own_presets, v.presets, 'ht-rp-');
    $('#ht-r-max').value = v.max_setpoint == null ? '' : String(v.max_setpoint);
    $('#ht-r-error').hidden = true;
    S.openModal('ht-room-modal');
  }
  $('#ht-r-save').addEventListener('click', function () {
    var p = readPresets('ht-rp-', false);
    var raw = $('#ht-r-max').value.trim().replace(',', '.');
    var max = raw ? Number(raw) : null;
    var err = $('#ht-r-error');
    if (!p || (max != null && !(max >= 5 && max <= 30))) { err.textContent = T('heat.ui.temps_invalid'); err.hidden = false; return; }
    S.api('PUT', 'heating/rooms/' + Number(settingsFor.id), { presets: p, max_setpoint: max }).then(function () { S.closeModal('ht-room-modal'); S.toast(T('heat.ui.saved')); load(); },
      function (e) { err.textContent = (e && e.message) || T('common.error'); err.hidden = false; });
  });

  // ─── Holiday ───────────────────────────────────
  function localInput(ms) { var d = new Date(ms); var p = function (n) { return String(n).padStart(2, '0'); }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function presetSelect(sel, value) {
    S.clear(sel);
    PRESETS.forEach(function (p) { var o = el('option', { value: p, text: H.pname(p) }); if (p === value) o.selected = true; sel.appendChild(o); });
  }
  function openVacation() {
    var v = data.house.vacation;
    var start = new Date(data.now); start.setHours(start.getHours() + 1, 0, 0, 0);
    var end = new Date(start.getTime() + 7 * 86400000); end.setHours(18, 0, 0, 0);
    $('#ht-v-from').value = localInput(v ? Date.parse(v.from) : start.getTime());
    $('#ht-v-to').value = localInput(v ? Date.parse(v.to) : end.getTime());
    $('#ht-v-pre').value = String(v ? v.preheat_h : 4);
    presetSelect($('#ht-v-preset'), v ? v.preset : 'eco');
    var host = S.clear($('#ht-v-rooms'));
    data.rooms.forEach(function (r) {
      var sel = el('select', { class: 'form-select', 'data-room': String(r.id), 'aria-label': T('heat.ui.vacation_preset_of', { name: r.name }) });
      sel.appendChild(el('option', { value: '', text: T('heat.ui.like_house') }));
      PRESETS.forEach(function (p) { var o = el('option', { value: p, text: H.pname(p) }); if (v && v.rooms && v.rooms[String(r.id)] === p) o.selected = true; sel.appendChild(o); });
      host.appendChild(el('div', { class: 'ht-devrow' }, [el('div', { class: 'grow' }, [el('b', { text: r.name })]), sel]));
    });
    $('#ht-v-delete').hidden = !v;
    $('#ht-v-error').hidden = true;
    S.openModal('ht-vac-modal');
  }
  $('#ht-vac-open').addEventListener('click', openVacation);
  $('#ht-v-save').addEventListener('click', function () {
    var from = new Date($('#ht-v-from').value).getTime();
    var to = new Date($('#ht-v-to').value).getTime();
    var err = $('#ht-v-error');
    if (!isFinite(from) || !isFinite(to) || to <= from) { err.textContent = T('heat.ui.vacation_invalid'); err.hidden = false; return; }
    var rooms = {};
    $$('#ht-v-rooms select').forEach(function (s) { if (s.value) rooms[s.getAttribute('data-room')] = s.value; });
    S.api('PUT', 'heating/vacation', { from: new Date(from).toISOString(), to: new Date(to).toISOString(), preheat_h: Number($('#ht-v-pre').value || 4), preset: $('#ht-v-preset').value, rooms: rooms })
      .then(function () { S.closeModal('ht-vac-modal'); S.toast(T('heat.ui.saved')); load(); }, function (e) { err.textContent = (e && e.message) || T('common.error'); err.hidden = false; });
  });
  $('#ht-v-delete').addEventListener('click', function () {
    S.api('DELETE', 'heating/vacation').then(function () { S.closeModal('ht-vac-modal'); load(); }, warn);
  });

  // ─── Weekly plan editor ────────────────────────
  var TPL = {
    work: function () { var wd = [[0, 'night'], [360, 'comfort'], [480, 'eco'], [960, 'comfort'], [1350, 'night']]; var we = [[0, 'night'], [450, 'comfort'], [1380, 'night']]; return [wd, wd, wd, wd, wd, we, we]; },
    home: function () { var d = [[0, 'night'], [390, 'comfort'], [1320, 'night']]; return [d, d, d, d, d, d, d]; },
    kids: function () { var wd = [[0, 'night'], [390, 'comfort'], [450, 'eco'], [780, 'comfort'], [1200, 'night']]; var we = [[0, 'night'], [480, 'comfort'], [1230, 'night']]; return [wd, wd, wd, wd, wd, we, we]; },
    eco: function () { var d = [[0, 'eco']]; return [d, d, d, d, d, d, d]; },
  };
  function copyWeek(w) { return w.map(function (d) { return d.map(function (s) { return [s[0], s[1]]; }); }); }
  function merge(dayList) {
    var out = [];
    dayList.sort(function (a, b) { return a[0] - b[0]; }).forEach(function (s) {
      if (out.length && out[out.length - 1][0] === s[0]) { out[out.length - 1][1] = s[1]; return; }
      if (out.length && out[out.length - 1][1] === s[1]) return;
      out.push([s[0], s[1]]);
    });
    if (!out.length || out[0][0] !== 0) out.unshift([0, out.length ? out[0][1] : 'eco']);
    return out;
  }
  function sections(dayList) { return dayList.map(function (s, i) { return { from: s[0], to: i + 1 < dayList.length ? dayList[i + 1][0] : 1440, preset: s[1] }; }); }
  function temps() {
    var p = readPresets('ht-pp-', false) || {};
    var out = {};
    PRESETS.forEach(function (k) { out[k] = p[k] != null ? p[k] : data.house.presets[k]; });
    return out;
  }
  function openEditor(pid, withRoom) {
    var p = pid != null ? data.plans.filter(function (x) { return x.id === pid; })[0] : null;
    editor = { id: p ? p.id : null, week: p ? copyWeek(p.week) : TPL.work(), sel: { d: 0, i: 0 }, rooms: {} };
    (p ? p.rooms.map(function (r) { return r.id; }) : (withRoom != null ? [withRoom] : [])).forEach(function (id) { editor.rooms[id] = true; });
    $('#ht-p-title').textContent = p ? T('heat.ui.plan_edit') : T('heat.ui.new_plan');
    $('#ht-p-name').value = p ? p.name : '';
    $('#ht-p-tpl').value = '';
    presetInputs($('#ht-p-presets'), p ? p.presets : {}, data.house.presets, 'ht-pp-');
    $$('#ht-p-presets input').forEach(function (i) { i.addEventListener('change', function () { fillSegPresets(); }); });
    var win = p ? p.window : { on: true, min: 2 };
    setSwitch($('#ht-p-win'), win.on);
    var wm = S.clear($('#ht-p-win-min'));
    [1, 2, 5].forEach(function (m) { var o = el('option', { value: String(m), text: T('heat.ui.after_min', { n: m }) }); if (m === win.min) o.selected = true; wm.appendChild(o); });
    winSub();
    setSwitch($('#ht-p-away'), p ? p.away : true);
    S.clear($('#ht-p-legend')).appendChild(H.legend());
    var w = S.clear($('#ht-p-where'));
    w.appendChild(H.icon('alert', 18));
    w.appendChild(el('div', null, [el('b', { text: T('heat.ui.server_title') }), ' ' + T('heat.ui.editor_server')]));
    var ds = S.clear($('#ht-se-day'));
    DAYS.forEach(function (d, i) { ds.appendChild(el('option', { value: String(i), text: dayName(i) })); });
    var cp = S.clear($('#ht-se-copy'));
    cp.appendChild(el('option', { value: '', text: T('heat.ui.copy_day') }));
    [['wd', T('heat.ui.copy_wd')], ['we', T('heat.ui.copy_we')], ['all', T('heat.ui.copy_all')]].concat(DAYS.map(function (d, i) { return [String(i), dayName(i)]; })).forEach(function (x) { cp.appendChild(el('option', { value: x[0], text: x[1] })); });
    $('#ht-p-delete').hidden = !p;
    $('#ht-p-error').hidden = true;
    renderChips();
    renderWeek();
    S.openModal('ht-plan-modal', '#ht-p-name');
  }
  function winSub() { $('#ht-p-win-sub').textContent = T('heat.ui.ex_window_sub', { min: $('#ht-p-win-min').value }); }
  $('#ht-p-win-min').addEventListener('change', winSub);
  $('#ht-p-win').addEventListener('click', function () { setSwitch(this, !this.classList.contains('on')); });
  $('#ht-p-away').addEventListener('click', function () { setSwitch(this, !this.classList.contains('on')); });
  function renderChips() {
    var host = S.clear($('#ht-p-rooms'));
    var own = [];
    (data.all_rooms || []).forEach(function (r) {
      var on = !!editor.rooms[r.id];
      var other = r.plan_id && r.plan_id !== editor.id ? data.plans.filter(function (p) { return p.id === r.plan_id; })[0] : null;
      var small = (r.thermostats === 1 ? T('heat.ui.one_thermostat') : T('heat.ui.n_thermostats', { n: r.thermostats })) + (other ? ' · ' + T('heat.ui.has_plan', { name: other.name }) : '');
      var b = el('button', { type: 'button', class: 'ht-chip', 'aria-pressed': on ? 'true' : 'false' }, [r.name + ' ', el('small', { text: small })]);
      b.addEventListener('click', function () { editor.rooms[r.id] = !editor.rooms[r.id]; renderChips(); });
      host.appendChild(b);
      if (on) own = own.concat(r.own_schedule || []);
    });
    var box = $('#ht-p-own');
    S.clear(box);
    box.hidden = !own.length;
    if (own.length) {
      box.appendChild(H.icon('alert', 16));
      box.appendChild(el('span', { text: T('heat.ui.own_schedule_hint', { names: own.join(', ') }) }));
    }
  }
  function fillSegPresets() {
    var t = temps();
    var sel = $('#ht-se-p');
    var cur = sel.value;
    S.clear(sel);
    PRESETS.forEach(function (p) { sel.appendChild(el('option', { value: p, text: H.pname(p) + ' ' + H.deg(t[p]) })); });
    if (cur) sel.value = cur;
  }
  function renderWeek() {
    var host = S.clear($('#ht-p-week'));
    editor.week.forEach(function (dayList, d) {
      var row = el('div', { class: 'ht-wrow' }, [el('span', { class: 'd', text: T('heat.ui.day_short_' + DAYS[d]) })]);
      var b = H.bar(sections(dayList), { interactive: true, dayName: dayName(d), label: dayName(d), onPick: function (i) { editor.sel = { d: d, i: i }; renderWeek(); } });
      row.appendChild(b);
      host.appendChild(row);
      if (editor.sel.d === d) { var sg = b.querySelectorAll('.ht-sg')[editor.sel.i]; if (sg) sg.classList.add('sel'); }
    });
    host.appendChild(el('div', { class: 'ht-wrow' }, [el('span'), H.ticks()]));
    fillSegPresets();
    var secs = sections(editor.week[editor.sel.d]);
    if (editor.sel.i >= secs.length) editor.sel.i = secs.length - 1;
    var s = secs[editor.sel.i];
    $('#ht-se-day').value = String(editor.sel.d);
    $('#ht-se-from').value = H.hm(s.from);
    $('#ht-se-to').value = s.to >= 1440 ? '23:59' : H.hm(s.to);
    $('#ht-se-from').disabled = editor.sel.i === 0;
    $('#ht-se-to').disabled = editor.sel.i === secs.length - 1;
    $('#ht-se-p').value = s.preset;
  }
  function setDay(d, list) { editor.week[d] = merge(list); }
  $('#ht-se-day').addEventListener('change', function () { editor.sel = { d: Number(this.value), i: 0 }; renderWeek(); });
  $('#ht-se-p').addEventListener('change', function () {
    var list = copyWeek(editor.week)[editor.sel.d];
    var start = list[editor.sel.i][0];
    list[editor.sel.i][1] = this.value;
    setDay(editor.sel.d, list);
    editor.sel.i = indexAt(editor.week[editor.sel.d], start);
    renderWeek();
  });
  function indexAt(list, min) { var i = 0; list.forEach(function (s, k) { if (s[0] <= min) i = k; }); return i; }
  $('#ht-se-from').addEventListener('change', function () {
    var m = parseHm(this.value);
    var list = copyWeek(editor.week)[editor.sel.d];
    var i = editor.sel.i;
    if (m == null || i === 0) { renderWeek(); return; }
    var lo = list[i - 1][0] + 15;
    var hi = (i + 1 < list.length ? list[i + 1][0] : 1440) - 15;
    list[i][0] = Math.max(lo, Math.min(hi, grid(m)));
    var at = list[i][0];
    setDay(editor.sel.d, list);
    editor.sel.i = indexAt(editor.week[editor.sel.d], at);
    renderWeek();
  });
  $('#ht-se-to').addEventListener('change', function () {
    var m = parseHm(this.value);
    var list = copyWeek(editor.week)[editor.sel.d];
    var i = editor.sel.i;
    if (m == null || i + 1 >= list.length) { renderWeek(); return; }
    var lo = list[i][0] + 15;
    var hi = (i + 2 < list.length ? list[i + 2][0] : 1440) - 15;
    list[i + 1][0] = Math.max(lo, Math.min(hi, grid(m)));
    setDay(editor.sel.d, list);
    renderWeek();
  });
  $('#ht-se-split').addEventListener('click', function () {
    var list = copyWeek(editor.week)[editor.sel.d];
    var secs = sections(list);
    var s = secs[editor.sel.i];
    if (s.to - s.from < 30 || list.length >= 12) { S.toast(T('heat.ui.split_no'), 'error'); return; }
    var mid = grid((s.from + s.to) / 2);
    if (mid <= s.from) mid = s.from + 15;
    var other = PRESETS.filter(function (p) { return p !== s.preset; })[0];
    list.splice(editor.sel.i + 1, 0, [mid, other]);
    // the half after stays like the section after it would be: only the new half gets another preset
    if (editor.sel.i + 2 < list.length && list[editor.sel.i + 2][1] === other) list[editor.sel.i + 1][1] = PRESETS.filter(function (p) { return p !== s.preset && p !== other; })[0];
    setDay(editor.sel.d, list);
    editor.sel.i = indexAt(editor.week[editor.sel.d], mid);
    renderWeek();
  });
  $('#ht-se-copy').addEventListener('change', function () {
    var v = this.value;
    this.value = '';
    if (!v) return;
    var targets = v === 'wd' ? [0, 1, 2, 3, 4] : (v === 'we' ? [5, 6] : (v === 'all' ? [0, 1, 2, 3, 4, 5, 6] : [Number(v)]));
    var src = editor.week[editor.sel.d];
    targets.forEach(function (d) { if (d !== editor.sel.d) editor.week[d] = copyWeek([src])[0]; });
    renderWeek();
    S.toast(T('heat.ui.copied'));
  });
  $('#ht-p-tpl').addEventListener('change', function () {
    if (!this.value || !TPL[this.value]) return;
    editor.week = TPL[this.value]();
    editor.sel = { d: 0, i: 0 };
    if (!$('#ht-p-name').value.trim()) $('#ht-p-name').value = this.options[this.selectedIndex].textContent;
    renderWeek();
  });
  $('#ht-p-today').addEventListener('click', function () {
    var d = new Date(data.now);
    var dd = (d.getDay() + 6) % 7;
    editor.sel = { d: dd, i: indexAt(editor.week[dd], d.getHours() * 60 + d.getMinutes()) };
    renderWeek();
    var sg = $('#ht-p-week .ht-sg.sel');
    if (sg) sg.focus();
  });
  $('#ht-p-save').addEventListener('click', function () {
    var err = $('#ht-p-error');
    var name = $('#ht-p-name').value.trim();
    var presets = readPresets('ht-pp-', false);
    if (!name) { err.textContent = T('heat.ui.name_missing'); err.hidden = false; return; }
    if (!presets) { err.textContent = T('heat.ui.temps_invalid'); err.hidden = false; return; }
    var body = { name: name, week: editor.week, presets: presets, window: { on: $('#ht-p-win').classList.contains('on'), min: Number($('#ht-p-win-min').value) },
      away: $('#ht-p-away').classList.contains('on'), rooms: Object.keys(editor.rooms).filter(function (k) { return editor.rooms[k]; }).map(Number) };
    var call = editor.id == null ? S.api('POST', 'heating/plans', body) : S.api('PUT', 'heating/plans/' + Number(editor.id), body);
    call.then(function () { S.closeModal('ht-plan-modal'); S.toast(T('heat.ui.plan_saved', { name: name })); load(); }, function (e) { err.textContent = (e && e.message) || T('common.error'); err.hidden = false; });
  });
  $('#ht-p-delete').addEventListener('click', function () {
    var name = $('#ht-p-name').value.trim();
    S.confirm(T('heat.ui.delete_confirm', { name: name }), T('heat.ui.delete_plan'), true).then(function (ok) {
      if (!ok) return;
      S.api('DELETE', 'heating/plans/' + Number(editor.id)).then(function () { S.closeModal('ht-plan-modal'); load(); }, warn);
    });
  });
  $('#ht-new').addEventListener('click', function () { openEditor(null); });

  load();
  setInterval(function () {
    if (document.hidden || S.$$('.modal-overlay').some(function (m) { return !m.hidden; })) return;
    var ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT')) return;
    load();
  }, 30000);
}());
