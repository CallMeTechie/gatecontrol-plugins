/* Alltag page: Müllabfuhr (plans, fractions, guided provider picker, ICS
   upload, rules) and Kalender (subscriptions). Everything goes through the
   plugin API (window.GC); the calendar's internet address never comes back. */
(function () {
  'use strict';
  var A = window.AT, T = A.T, $ = A.$, $$ = A.$$, el = A.el;
  var CTX = A.CTX;
  var ICON_WASTE = 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3';
  var ICS_MAX = 900 * 1024;

  var data = null;          // GET /status
  var editPlan = null;      // plan being edited (null = new)
  var editFrac = null;      // { plan, fraction }
  var editSub = null;       // subscription being edited (null = new)
  var planSource = 'provider';
  var subSource = 'url';
  var icsText = null;       // uploaded / pasted calendar of the plan dialog
  var icsName = null;
  var picker = { provider: null, service: null, place: null, street: null, house: null, streets: [] };

  function errText(e) { return (e && e.data && e.data.error) || (e && e.message) || T('common.error'); }
  function warn(e) { A.toast(errText(e), 'error'); }
  function when(ms) {
    if (!ms) return '–';
    try { return new Date(ms).toLocaleString(CTX.lang === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_) { return '–'; }
  }
  function setMsg(id, text, tone) { var m = $(id); if (m) { m.textContent = text || ''; m.style.color = tone === 'error' ? 'var(--crit)' : ''; } }

  // ── tabs ─────────────────────────────────────────────────────────────────
  function showTab(name) {
    ['waste', 'calendar'].forEach(function (n) {
      var on = n === name;
      $('#at-tab-' + n).classList.toggle('active', on);
      $('#at-tab-' + n).setAttribute('aria-selected', on ? 'true' : 'false');
      $('#at-pane-' + n).hidden = !on;
    });
  }
  $('#at-tab-waste').addEventListener('click', function () { showTab('waste'); });
  $('#at-tab-calendar').addEventListener('click', function () { showTab('calendar'); });

  // ── load ─────────────────────────────────────────────────────────────────
  function load() {
    return A.api('GET', 'status').then(function (r) { data = r; render(); }).catch(warn);
  }
  function render() {
    var c = data.config;
    var probs = (c.problems || []).map(function (p) { return T('problem.' + p); });
    $('#at-problems').hidden = !probs.length;
    $('#at-problems').textContent = probs.join(' ');
    $('#at-waste-off').hidden = c.waste_enabled;
    $('#at-cal-off').hidden = c.calendar_enabled;
    $('#at-waste-info').textContent = T('waste.info') + ' · ' + T('info.tz', { tz: c.timezone });
    $('#at-cal-info').textContent = T('cal.info', { allday: c.allday_time }) + ' · ' + T('info.tz', { tz: c.timezone });
    renderPlans();
    renderSubs();
  }

  // ── plans ────────────────────────────────────────────────────────────────
  function sourceLine(p) {
    if (p.source === 'provider') {
      var pc = p.provider_config || {};
      var prov = (data.providers || []).find(function (x) { return x.id === p.provider; });
      var where = [pc.place && pc.place.name, pc.street && pc.street.name, pc.house && pc.house.name].filter(Boolean).join(', ');
      return (prov ? prov.title : p.provider) + ' · ' + (pc.serviceTitle || pc.service || '') + (where ? ' · ' + where : '');
    }
    if (p.source === 'ics') return T('source.ics') + (p.ics_name ? ' · ' + p.ics_name : '');
    return T('source.rules') + ' · ' + T('rules.count', { n: (p.rules || []).length });
  }
  function dayRows(days, empty) {
    if (!days.length) return el('div', { class: 'at-empty', text: empty });
    return el('div', { class: 'at-days' }, days.map(function (d) {
      return el('div', { class: 'at-day' }, [
        el('span', { class: 'at-day-l' + (d.label === T('rel.today') || d.label === T('rel.tomorrow') ? ' is-soon' : ''), text: d.label }),
        el('div', { class: 'at-chips' }, d.fractions.map(A.chip)),
      ]);
    }));
  }
  /** "1 Tag vorher, 18:00 · zusätzlich am Abholtag 06:30" */
  function remindText(r) {
    if (!r) return '';
    var parts = [r.lead === 'off' ? T('remind.off') : T('plan.remind_at', { lead: T('remind.' + r.lead), time: r.time })];
    if (r.extra) parts.push(T('plan.remind_extra_short', { time: r.extra_time }));
    return parts.join(' · ') + (r.custom ? '' : ' ' + T('plan.remind_default'));
  }
  function people(list, allText) {
    return el('div', { class: 'at-people' }, [el('span', { class: 'at-lbl', text: T('plan.people') })].concat(
      list == null ? [el('span', { class: 'at-person', text: allText })]
        : (list.length ? list.map(function (u) { return el('span', { class: 'at-person', text: u.username }); }) : [el('span', { class: 'muted', text: T('people.none') })])));
  }
  function planCard(p) {
    var status = p.status === 'error' ? el('span', { class: 'tag', 'data-tone': 'error', text: T('status.error') })
      : el('span', { class: 'tag', 'data-tone': p.status === 'ok' ? 'good' : null, text: T(p.status === 'ok' ? 'status.ok' : 'status.new') });
    var ic = el('div', { class: 'at-ic' }); ic.appendChild(A.svg(ICON_WASTE, 20));
    var meta = [el('span', { text: T('meta.dates', { n: p.date_count }) })];
    if (p.last_success_at) meta.push(el('span', { text: T('meta.last', { when: when(p.last_success_at) }) }));
    if (p.status === 'error') meta.push(el('span', { class: 'is-error', text: T('meta.error', { when: when(p.last_attempt_at), error: p.error_text || p.last_error }) }));
    if (p.source === 'provider' && p.next_refresh_at) meta.push(el('span', { text: T('meta.next', { when: when(p.next_refresh_at) }) }));
    var fr = el('div', { class: 'at-chips' }, p.fractions.map(function (f) {
      var b = A.chip(f);
      var btn = el('button', { type: 'button', class: b.className, title: T('frac.edit'), on: { click: function () { openFrac(p, f); } } });
      btn.style.setProperty('--chip', b.style.getPropertyValue('--chip'));
      while (b.firstChild) btn.appendChild(b.firstChild);
      return btn;
    }));
    return el('div', { class: 'at-card' + (p.enabled ? '' : ' is-disabled'), 'data-id': String(p.id) }, [
      el('div', { class: 'at-head' }, [ic, el('div', { class: 'at-head-text' }, [el('div', { class: 'at-name', text: p.name }), el('div', { class: 'at-sub', text: sourceLine(p) })]), status]),
      el('div', null, [el('div', { class: 'at-lbl', text: T('plan.next') }), dayRows(p.upcoming || [], T('plan.no_dates'))]),
      p.fractions.length ? el('div', null, [el('div', { class: 'at-lbl', text: T('plan.fractions') }), fr]) : null,
      el('div', { class: 'at-sub at-remind-line', text: T('plan.remind_line', { text: remindText(p.reminder) }) }),
      people(p.users, T('plan.people_all')),
      el('div', { class: 'at-meta' }, meta),
      el('div', { class: 'at-foot' }, [
        el('button', { type: 'button', class: 'btn btn-sm', text: T('common.refresh'), on: { click: function (e) { refreshPlan(p, e.currentTarget); } } }),
        el('button', { type: 'button', class: 'btn btn-sm', text: T('common.edit'), on: { click: function () { openPlan(p); } } }),
      ]),
    ]);
  }
  function renderPlans() {
    var box = A.clear($('#at-plans'));
    if (!data.plans.length) { box.appendChild(el('div', { class: 'at-empty', text: T('plan.empty') })); return; }
    data.plans.forEach(function (p) { box.appendChild(planCard(p)); });
  }
  function refreshPlan(p, btn) {
    btn.disabled = true;
    A.api('POST', 'plans/' + p.id + '/refresh').then(function (r) {
      if (r.result && r.result.ok) A.toast(T('refresh.ok', { n: r.result.dates }));
      else A.toast(T('refresh.failed'), 'error');
      return load();
    }).catch(warn).then(function () { btn.disabled = false; });
  }

  // ── plan dialog ─────────────────────────────────────────────────────────
  function setPlanSource(s) {
    planSource = s;
    $$('#at-p-source .at-seg-btn').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-source') === s); });
    $('#at-p-provider').hidden = s !== 'provider';
    $('#at-p-ics').hidden = s !== 'ics';
    $('#at-p-rules').hidden = s !== 'rules';
  }
  $$('#at-p-source .at-seg-btn').forEach(function (b) { b.addEventListener('click', function () { setPlanSource(b.getAttribute('data-source')); }); });

  function option(value, label, selected) { return el('option', { value: value, text: label, selected: selected ? 'selected' : null }); }
  function fill(sel, items, placeholder, current) {
    A.clear(sel);
    if (placeholder) sel.appendChild(option('', placeholder));
    items.forEach(function (i) { sel.appendChild(option(i.id, i.name || i.title, current != null && String(current) === String(i.id))); });
  }

  // provider picker: provider → service → place → street → house number
  function provider() { return (data.providers || []).find(function (x) { return x.id === $('#at-p-prov').value; }) || null; }
  function serviceId() { return $('#at-p-service').value === '__custom' ? $('#at-p-custom').value.trim() : $('#at-p-service').value; }
  function resetBelow(level) {
    if (level <= 1) { picker.place = null; fill($('#at-p-place'), [], T('provider.choose')); $('#at-p-place').disabled = true; }
    if (level <= 2) { picker.street = null; picker.streets = []; $('#at-p-street-group').hidden = true; A.clear($('#at-p-street')); $('#at-p-street-filter').value = ''; }
    if (level <= 3) { picker.house = null; $('#at-p-house-group').hidden = true; A.clear($('#at-p-house')); }
    A.clear($('#at-p-preview-list'));
    updatePreviewBtn();
  }
  function updatePreviewBtn() {
    var ok = !!picker.place && ($('#at-p-street-group').hidden || !!picker.street) && ($('#at-p-house-group').hidden || !!picker.house);
    $('#at-p-preview').disabled = !ok;
  }
  function lookup(body) {
    setMsg('#at-p-prov-msg', T('provider.loading'));
    return A.api('POST', 'providers/lookup', body).then(function (r) { setMsg('#at-p-prov-msg', ''); return r; })
      .catch(function (e) { setMsg('#at-p-prov-msg', errText(e), 'error'); throw e; });
  }
  function fillServices(current) {
    var p = provider();
    fill($('#at-p-service'), p ? p.services : [], T('provider.choose'), current);
    $('#at-p-service').appendChild(option('__custom', T('provider.other')));
    if (current && p && !p.services.some(function (s) { return s.id === current; })) { $('#at-p-service').value = '__custom'; $('#at-p-custom').value = current; }
    $('#at-p-custom-group').hidden = $('#at-p-service').value !== '__custom';
  }
  function loadPlaces(cfg) {
    resetBelow(1);
    var service = serviceId();
    if (!service) return Promise.resolve();
    return lookup({ provider: $('#at-p-prov').value, service: service }).then(function (r) {
      fill($('#at-p-place'), r.items, T('provider.choose'), cfg && cfg.place && cfg.place.id);
      $('#at-p-place').disabled = false;
      if (r.items.length === 1) $('#at-p-place').value = r.items[0].id;
      if ($('#at-p-place').value) return placeChosen(cfg);
    }).catch(function () {});
  }
  function placeChosen(cfg) {
    resetBelow(2);
    var sel = $('#at-p-place');
    if (!sel.value) return Promise.resolve();
    picker.place = { id: sel.value, name: sel.options[sel.selectedIndex].text };
    updatePreviewBtn();
    return lookup({ provider: $('#at-p-prov').value, service: serviceId(), place: picker.place.id }).then(function (r) {
      picker.streets = r.items;
      if (!r.items.length) { updatePreviewBtn(); return; }
      $('#at-p-street-group').hidden = false;
      filterStreets(cfg && cfg.street && cfg.street.id);
      if (r.items.length === 1) $('#at-p-street').value = r.items[0].id;
      if ($('#at-p-street').value) return streetChosen(cfg);
      updatePreviewBtn();
    }).catch(function () {});
  }
  function filterStreets(current) {
    var q = $('#at-p-street-filter').value.trim().toLowerCase();
    var list = picker.streets.filter(function (s) { return !q || s.name.toLowerCase().indexOf(q) >= 0; }).slice(0, 400);
    fill($('#at-p-street'), list, null, current || (picker.street && picker.street.id));
  }
  function streetChosen(cfg) {
    resetBelow(3);
    var sel = $('#at-p-street');
    if (!sel.value) return Promise.resolve();
    picker.street = { id: sel.value, name: sel.options[sel.selectedIndex].text };
    updatePreviewBtn();
    return lookup({ provider: $('#at-p-prov').value, service: serviceId(), place: picker.place.id, street: picker.street.id }).then(function (r) {
      if (!r.items.length) { updatePreviewBtn(); return; }
      $('#at-p-house-group').hidden = false;
      fill($('#at-p-house'), r.items, T('provider.choose'), cfg && cfg.house && cfg.house.id);
      if ($('#at-p-house').value) houseChosen();
      updatePreviewBtn();
    }).catch(function () {});
  }
  function houseChosen() {
    var sel = $('#at-p-house');
    picker.house = sel.value ? { id: sel.value, name: sel.options[sel.selectedIndex].text } : null;
    A.clear($('#at-p-preview-list'));
    updatePreviewBtn();
  }
  $('#at-p-prov').addEventListener('change', function () { fillServices(null); resetBelow(1); });
  $('#at-p-service').addEventListener('change', function () {
    $('#at-p-custom-group').hidden = $('#at-p-service').value !== '__custom';
    if ($('#at-p-service').value !== '__custom') loadPlaces(null); else resetBelow(1);
  });
  $('#at-p-custom').addEventListener('change', function () { loadPlaces(null); });
  $('#at-p-place').addEventListener('change', function () { placeChosen(null); });
  $('#at-p-street-filter').addEventListener('input', function () { filterStreets(null); });
  $('#at-p-street').addEventListener('change', function () { streetChosen(null); });
  $('#at-p-house').addEventListener('change', houseChosen);
  function providerConfig() {
    return { service: serviceId(), place: picker.place, street: $('#at-p-street-group').hidden ? null : picker.street, house: $('#at-p-house-group').hidden ? null : picker.house };
  }
  $('#at-p-preview').addEventListener('click', function () {
    var btn = $('#at-p-preview');
    btn.disabled = true;
    setMsg('#at-p-prov-msg', T('provider.loading'));
    A.api('POST', 'providers/preview', { provider: $('#at-p-prov').value, provider_config: providerConfig() }).then(function (r) {
      setMsg('#at-p-prov-msg', r.dates.length ? T('provider.preview_ok', { n: r.dates.length }) : T('provider.preview_none'));
      previewList('#at-p-preview-list', r.dates);
    }).catch(function (e) { setMsg('#at-p-prov-msg', errText(e), 'error'); }).then(function () { btn.disabled = false; });
  });
  function previewList(id, list) {
    var box = A.clear($(id));
    var byDate = [];
    list.forEach(function (d) {
      var last = byDate[byDate.length - 1];
      if (!last || last.date !== d.date) { last = { date: d.date, fractions: [] }; byDate.push(last); }
      last.fractions.push({ name: d.name, type: d.type, color: d.color });
    });
    byDate.slice(0, 12).forEach(function (d) {
      box.appendChild(el('div', { class: 'at-day' }, [el('span', { class: 'at-day-l', text: d.date.split('-').reverse().join('.') }), el('div', { class: 'at-chips' }, d.fractions.map(A.chip))]));
    });
  }

  // ICS upload (file or pasted text) — checked by the server before saving
  function icsLoaded(text, name) {
    icsText = null; icsName = null;
    A.clear($('#at-p-ics-preview'));
    if (!text) { setMsg('#at-p-ics-msg', ''); return; }
    if (text.length > ICS_MAX) { setMsg('#at-p-ics-msg', T('error.ics_too_large'), 'error'); return; }
    setMsg('#at-p-ics-msg', T('provider.loading'));
    A.api('POST', 'ics/preview', { ics: text }).then(function (r) {
      icsText = text; icsName = name || 'kalender.ics';
      setMsg('#at-p-ics-msg', T('ics.ok', { n: r.count, f: r.fractions.length }));
      var box = A.clear($('#at-p-ics-preview'));
      box.appendChild(el('div', { class: 'at-chips' }, r.fractions.map(A.chip)));
    }).catch(function (e) { setMsg('#at-p-ics-msg', errText(e), 'error'); });
  }
  $('#at-p-file').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    if (f.size > ICS_MAX) { setMsg('#at-p-ics-msg', T('error.ics_too_large'), 'error'); return; }
    var rd = new FileReader();
    rd.onload = function () { icsLoaded(String(rd.result || ''), f.name); };
    rd.onerror = function () { setMsg('#at-p-ics-msg', T('common.error'), 'error'); };
    rd.readAsText(f);
  });
  $('#at-p-ics-text').addEventListener('change', function () { icsLoaded(this.value, 'kalender.ics'); });

  // rules and exceptions rows
  function typeSelect(value) {
    var s = el('select', { class: 'form-select' });
    s.appendChild(option('', T('frac.type_auto'), !value));
    (CTX.fractionTypes || []).forEach(function (ty) { s.appendChild(option(ty, T('type.' + ty), value === ty)); });
    return s;
  }
  function field(label, input) { return el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: label }), input]); }
  function ruleRow(r) {
    r = r || {};
    var row = el('div', { class: 'at-rule' }, [
      field(T('rules.name'), el('input', { class: 'form-input', 'data-k': 'name', type: 'text', maxlength: '60', value: r.name || '', placeholder: T('rules.name_ph') })),
      field(T('frac.type'), typeSelect(r.type)),
      field(T('rules.start'), el('input', { class: 'form-input', 'data-k': 'start', type: 'date', value: r.start || '' })),
      field(T('rules.weeks'), el('input', { class: 'form-input', 'data-k': 'weeks', type: 'number', min: '1', max: '52', value: String(r.weeks || 2) })),
      field(T('rules.until'), el('input', { class: 'form-input', 'data-k': 'until', type: 'date', value: r.until || '' })),
      el('button', { type: 'button', class: 'btn at-x', 'aria-label': T('common.remove'), text: '×', on: { click: function () { row.remove(); } } }),
    ]);
    row.querySelector('select').setAttribute('data-k', 'type');
    return row;
  }
  function excRow(x) {
    x = x || {};
    var action = el('select', { class: 'form-select', 'data-k': 'action' }, [option('cancel', T('exc.cancelled'), !x.to), option('move', T('exc.moved'), !!x.to)]);
    var to = el('input', { class: 'form-input', 'data-k': 'to', type: 'date', value: x.to || '' });
    to.disabled = !x.to;
    action.addEventListener('change', function () { to.disabled = action.value !== 'move'; });
    var row = el('div', { class: 'at-exc' }, [
      field(T('exc.date'), el('input', { class: 'form-input', 'data-k': 'date', type: 'date', value: x.date || '' })),
      field(T('exc.fraction'), el('input', { class: 'form-input', 'data-k': 'name', type: 'text', maxlength: '60', value: x.name || '', placeholder: T('exc.all') })),
      field(T('exc.action'), action),
      field(T('exc.to'), to),
      el('button', { type: 'button', class: 'btn at-x', 'aria-label': T('common.remove'), text: '×', on: { click: function () { row.remove(); } } }),
    ]);
    return row;
  }
  $('#at-p-rule-add').addEventListener('click', function () { $('#at-p-rule-rows').appendChild(ruleRow(null)); });
  $('#at-p-exc-add').addEventListener('click', function () { $('#at-p-exc-rows').appendChild(excRow(null)); });
  function val(row, k) { var i = row.querySelector('[data-k="' + k + '"]'); return i ? i.value : ''; }
  function collectRules() {
    return $$('#at-p-rule-rows .at-rule').map(function (r) {
      return { name: val(r, 'name').trim(), type: val(r, 'type') || null, start: val(r, 'start'), weeks: Number(val(r, 'weeks')), until: val(r, 'until') || null };
    }).filter(function (r) { return r.name || r.start; });
  }
  function collectExceptions() {
    return $$('#at-p-exc-rows .at-exc').map(function (r) {
      return { date: val(r, 'date'), name: val(r, 'name').trim() || null, to: val(r, 'action') === 'move' ? (val(r, 'to') || null) : null };
    }).filter(function (x) { return x.date; });
  }

  function userChecks(boxId, selected) {
    var box = A.clear($(boxId));
    (data.users || []).forEach(function (u) {
      box.appendChild(el('label', { class: 'at-check-row' }, [
        el('input', { type: 'checkbox', value: String(u.id), checked: selected.indexOf(u.id) >= 0 }),
        el('span', { text: u.username + (u.role === 'admin' ? ' · ' + T('people.admin') : '') }),
      ]));
    });
    if (!(data.users || []).length) box.appendChild(el('div', { class: 'muted', text: T('people.unavailable') }));
  }
  function checkedUsers(boxId) { return $$(boxId + ' input:checked').map(function (i) { return Number(i.value); }); }
  $('#at-p-users-all').addEventListener('change', function () { $('#at-p-user-list').hidden = true; });
  $('#at-p-users-some').addEventListener('change', function () { $('#at-p-user-list').hidden = false; });

  // reminder: lead (none / on the day / 1–3 days before) at a time, optionally also on the pickup day
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  function remindDefaults() {
    var c = data.config || {};
    return { lead: 1, time: c.evening || '18:00', extra: !!c.morning, extra_time: c.morning_time || '06:30' };
  }
  function syncRemind() {
    var off = $('#at-p-lead').value === 'off';
    $('#at-p-time').disabled = off;
    $('#at-p-extra').disabled = off;
    if (off) $('#at-p-extra').checked = false;
    $('#at-p-extra-time').disabled = off || !$('#at-p-extra').checked;
  }
  function setRemind(r) {
    $('#at-p-lead').value = String(r.lead);
    $('#at-p-time').value = r.time;
    $('#at-p-extra').checked = !!r.extra && r.lead !== 'off';
    $('#at-p-extra-time').value = r.extra_time;
    $('#at-p-lead').setAttribute('data-prev', String(r.lead));
    syncRemind();
  }
  $('#at-p-lead').addEventListener('change', function () {
    // "Am Abholtag" with the evening time (or back): take the matching default time
    var d = remindDefaults();
    var prev = this.getAttribute('data-prev');
    var t = $('#at-p-time').value;
    if (this.value === '0' && prev !== '0' && t === d.time) $('#at-p-time').value = d.extra_time;
    else if (this.value !== '0' && this.value !== 'off' && prev === '0' && t === d.extra_time) $('#at-p-time').value = d.time;
    this.setAttribute('data-prev', this.value);
    syncRemind();
  });
  $('#at-p-extra').addEventListener('change', syncRemind);
  function collectRemind() {
    var lead = $('#at-p-lead').value;
    var r = { lead: lead === 'off' ? 'off' : Number(lead), time: $('#at-p-time').value, extra: lead !== 'off' && $('#at-p-extra').checked, extra_time: $('#at-p-extra-time').value };
    var d = remindDefaults();
    if (!TIME_RE.test(r.time)) { if (lead === 'off') r.time = d.time; else return null; }
    if (!TIME_RE.test(r.extra_time)) { if (!r.extra) r.extra_time = d.extra_time; else return null; }
    return r;
  }

  function sameRemind(a, b) {
    return String(a.lead) === String(b.lead) && (a.lead === 'off' || a.time === b.time) && !!a.extra === !!b.extra && (!a.extra || a.extra_time === b.extra_time);
  }

  function openPlan(p) {
    editPlan = p || null;
    icsText = null; icsName = null;
    $('#at-plan-title').textContent = p ? T('plan.edit') : T('plan.add');
    $('#at-p-name').value = p ? p.name : (data.plans.length ? '' : T('plan.default_name'));
    $('#at-p-delete').hidden = !p;
    $('#at-p-enabled').checked = p ? p.enabled : true;
    setMsg('#at-p-msg', '');
    setMsg('#at-p-prov-msg', '');
    setMsg('#at-p-ics-msg', p && p.source === 'ics' && p.ics_name ? T('ics.current', { name: p.ics_name }) : '');
    A.clear($('#at-p-ics-preview'));
    $('#at-p-file').value = '';
    $('#at-p-ics-text').value = '';
    // provider picker
    fill($('#at-p-prov'), data.providers.map(function (x) { return { id: x.id, name: x.title }; }), null, p && p.provider);
    var cfg = p && p.source === 'provider' ? p.provider_config : null;
    fillServices(cfg ? cfg.service : null);
    resetBelow(1);
    if (cfg) loadPlaces(cfg);
    // rules, exceptions
    var rr = A.clear($('#at-p-rule-rows'));
    (p && p.rules && p.rules.length ? p.rules : [null]).forEach(function (r) { rr.appendChild(ruleRow(r)); });
    var er = A.clear($('#at-p-exc-rows'));
    ((p && p.exceptions) || []).forEach(function (x) { er.appendChild(excRow(x)); });
    $('#at-p-exc-box').open = !!(p && p.exceptions && p.exceptions.length);
    // people
    var some = !!(p && p.users);
    $('#at-p-users-all').checked = !some;
    $('#at-p-users-some').checked = some;
    $('#at-p-user-list').hidden = !some;
    userChecks('#at-p-user-list', some ? p.users.map(function (u) { return u.id; }) : []);
    setRemind(p && p.reminder ? p.reminder : remindDefaults());
    setPlanSource(p ? p.source : 'provider');
    A.openModal('at-plan-modal');
  }
  $('#at-plan-add').addEventListener('click', function () { openPlan(null); });

  $('#at-p-save').addEventListener('click', function () {
    var body = { name: $('#at-p-name').value.trim(), source: planSource, enabled: $('#at-p-enabled').checked, exceptions: collectExceptions() };
    body.users = $('#at-p-users-some').checked ? checkedUsers('#at-p-user-list') : null;
    body.reminder = collectRemind();
    if (!body.reminder) { setMsg('#at-p-msg', T('error.reminder_invalid'), 'error'); return; }
    // a plan still on the defaults (plugin settings) stays on them unless its reminder is changed here
    if (editPlan && editPlan.reminder && !editPlan.reminder.custom && sameRemind(body.reminder, editPlan.reminder)) delete body.reminder;
    if (planSource === 'provider') {
      if ($('#at-p-preview').disabled) { setMsg('#at-p-msg', T('provider.incomplete'), 'error'); return; }
      body.provider = $('#at-p-prov').value;
      body.provider_config = providerConfig();
    } else if (planSource === 'ics') {
      if (icsText) { body.ics = icsText; body.ics_name = icsName; } else if (!editPlan || editPlan.source !== 'ics') { setMsg('#at-p-msg', T('error.ics_required'), 'error'); return; }
    } else body.rules = collectRules();
    var btn = $('#at-p-save');
    btn.disabled = true;
    setMsg('#at-p-msg', T('common.saving'));
    var req = editPlan ? A.api('PUT', 'plans/' + editPlan.id, body) : A.api('POST', 'plans', body);
    req.then(function (r) {
      A.closeModal('at-plan-modal');
      if (r.result && !r.result.ok) A.toast(T('refresh.saved_failed'), 'error'); else A.toast(T('common.saved'));
      return load();
    }).catch(function (e) { setMsg('#at-p-msg', errText(e), 'error'); }).then(function () { btn.disabled = false; });
  });
  $('#at-p-delete').addEventListener('click', function () {
    if (!editPlan) return;
    var p = editPlan;
    A.confirm(T('plan.delete_confirm', { name: p.name }), T('common.delete'), true).then(function (ok) {
      if (!ok) return;
      A.api('DELETE', 'plans/' + p.id).then(function () { A.closeModal('at-plan-modal'); A.toast(T('common.deleted')); return load(); }).catch(warn);
    });
  });

  // ── fraction dialog ──────────────────────────────────────────────────────
  function openFrac(p, f) {
    editFrac = { plan: p, fraction: f };
    $('#at-f-source').textContent = T('frac.source', { name: f.source_name });
    $('#at-f-name').value = f.renamed ? f.name : '';
    $('#at-f-name').placeholder = f.source_name;
    var sel = A.clear($('#at-f-type'));
    (CTX.fractionTypes || []).forEach(function (ty) { sel.appendChild(option(ty, T('type.' + ty), ty === f.type)); });
    $('#at-f-color').value = A.safeColor(f.color, '#64748b');
    $('#at-f-hidden').checked = !!f.hidden;
    A.openModal('at-frac-modal');
  }
  $('#at-f-type').addEventListener('change', function () { $('#at-f-color').value = (CTX.fractionColors || {})[this.value] || '#64748b'; });
  function saveFrac(body) {
    var e = editFrac;
    return A.api('PUT', 'plans/' + e.plan.id + '/fractions/' + e.fraction.id, body).then(function () {
      A.closeModal('at-frac-modal'); A.toast(T('common.saved')); return load();
    }).catch(warn);
  }
  $('#at-f-save').addEventListener('click', function () {
    var type = $('#at-f-type').value;
    var color = $('#at-f-color').value;
    saveFrac({ name: $('#at-f-name').value.trim() || null, type: type, color: color === (CTX.fractionColors || {})[type] ? null : color, hidden: $('#at-f-hidden').checked });
  });
  $('#at-f-reset').addEventListener('click', function () { saveFrac({ name: null, color: null, hidden: false }); });

  // ── subscriptions ────────────────────────────────────────────────────────
  function reminderText(s) {
    var parts = [T('reminder.' + s.reminder)];
    if (s.allday_reminder) parts.push(T('reminder.allday_short'));
    return parts.join(' · ');
  }
  function subCard(s) {
    var status = s.status === 'error' ? el('span', { class: 'tag', 'data-tone': 'error', text: T('status.error') })
      : el('span', { class: 'tag', 'data-tone': s.status === 'ok' ? 'good' : null, text: T(s.status === 'ok' ? 'status.ok' : 'status.new') });
    var dot = el('span', { class: 'at-dot' }); dot.style.setProperty('--dot', A.safeColor(s.color, '#0d9488'));
    var where = s.source === 'url' ? s.address : T('sub.target_line', { target: s.target_label || T('sub.no_target'), path: s.target_path || '' });
    var meta = [el('span', { text: T('meta.events', { n: s.week_count, total: s.event_count }) + (s.truncated ? ' · ' + T('meta.truncated') : '') })];
    if (s.last_success_at) meta.push(el('span', { text: T('meta.last', { when: when(s.last_success_at) }) }));
    if (s.status === 'error') meta.push(el('span', { class: 'is-error', text: T('meta.error', { when: when(s.last_attempt_at), error: s.error_text || s.last_error }) }));
    var events = el('div', { class: 'at-events', hidden: true });
    return el('div', { class: 'at-card' + (s.enabled ? '' : ' is-disabled'), 'data-id': String(s.id) }, [
      el('div', { class: 'at-head' }, [dot, el('div', { class: 'at-head-text' }, [el('div', { class: 'at-name', text: s.name }), el('div', { class: 'at-sub' }, [el('span', { class: 'tag', text: where || '–' })])]), status]),
      el('div', { class: 'at-sub', text: T('sub.reminder') + ': ' + reminderText(s) }),
      el('div', { class: 'at-people' }, [el('span', { class: 'at-lbl', text: T('sub.people') })].concat(s.users.length
        ? s.users.map(function (u) { return el('span', { class: 'at-person', text: u.username }); }) : [el('span', { class: 'muted', text: T('people.none_cal') })])),
      el('div', { class: 'at-meta' }, meta),
      events,
      el('div', { class: 'at-foot' }, [
        el('button', { type: 'button', class: 'btn btn-sm', text: T('common.refresh'), on: { click: function (e) { refreshSub(s, e.currentTarget); } } }),
        el('button', { type: 'button', class: 'btn btn-sm', text: T('sub.show_events'), on: { click: function () { toggleEvents(s, events); } } }),
        el('button', { type: 'button', class: 'btn btn-sm', text: T('common.edit'), on: { click: function () { openSub(s); } } }),
      ]),
    ]);
  }
  function toggleEvents(s, box) {
    if (!box.hidden) { box.hidden = true; return; }
    A.api('GET', 'subscriptions/' + s.id + '/events').then(function (r) {
      A.clear(box);
      if (!r.events.length) box.appendChild(el('div', { class: 'muted', text: T('sub.no_events') }));
      r.events.forEach(function (e) {
        box.appendChild(el('div', { class: 'at-ev' }, [el('span', { class: 'at-ev-t', text: e.label + ' ' + (e.all_day ? T('portal.all_day') : e.time) }), el('span', { text: e.title })]));
      });
      box.hidden = false;
    }).catch(warn);
  }
  function renderSubs() {
    var box = A.clear($('#at-subs'));
    if (!data.subscriptions.length) { box.appendChild(el('div', { class: 'at-empty', text: T('sub.empty') })); return; }
    data.subscriptions.forEach(function (s) { box.appendChild(subCard(s)); });
  }
  function refreshSub(s, btn) {
    btn.disabled = true;
    A.api('POST', 'subscriptions/' + s.id + '/refresh').then(function (r) {
      if (r.result && r.result.ok) A.toast(r.result.unchanged ? T('refresh.unchanged') : T('refresh.events', { n: r.result.events }));
      else A.toast(T('refresh.failed'), 'error');
      return load();
    }).catch(warn).then(function () { btn.disabled = false; });
  }

  function setSubSource(s) {
    subSource = s;
    $$('#at-s-source .at-seg-btn').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-source') === s); });
    $('#at-s-url-box').hidden = s !== 'url';
    $('#at-s-target-box').hidden = s !== 'target';
  }
  $$('#at-s-source .at-seg-btn').forEach(function (b) { b.addEventListener('click', function () { setSubSource(b.getAttribute('data-source')); }); });

  function openSub(s) {
    editSub = s || null;
    $('#at-s-title').textContent = s ? T('sub.edit') : T('sub.add');
    $('#at-s-name').value = s ? s.name : '';
    $('#at-s-color').value = s ? A.safeColor(s.color, '#0d9488') : '#0d9488';
    $('#at-s-url').value = '';
    $('#at-s-url-hint').textContent = s && s.source === 'url' ? T('sub.url_saved', { host: s.address || '' }) : T('sub.url_hint');
    var h = data.hosts || { exact: [], suffix: [] };
    $('#at-s-hosts').textContent = T('sub.hosts', { hosts: h.exact.concat(h.suffix.map(function (x) { return '*.' + x; })).join(', ') });
    fill($('#at-s-target'), (data.targets || []).map(function (x) { return { id: x.index, name: x.label }; }), data.targets && data.targets.length ? null : T('sub.no_targets'), s && s.target_index);
    $('#at-s-path').value = s && s.target_path ? s.target_path : '';
    $('#at-s-user').value = '';
    $('#at-s-pass').value = '';
    $('#at-s-cred-hint').textContent = s && s.has_credentials ? T('sub.cred_saved') : T('sub.cred_hint');
    $('#at-s-reminder').value = s ? s.reminder : '15';
    $('#at-s-allday').checked = s ? s.allday_reminder : true;
    $('#at-s-enabled').checked = s ? s.enabled : true;
    $('#at-s-delete').hidden = !s;
    userChecks('#at-s-user-list', s ? s.users.map(function (u) { return u.id; }) : []);
    setSubSource(s ? s.source : 'url');
    setMsg('#at-s-msg', s ? '' : T('sub.people_default'));
    A.openModal('at-sub-modal');
  }
  $('#at-sub-add').addEventListener('click', function () { openSub(null); });
  $('#at-s-save').addEventListener('click', function () {
    var body = { name: $('#at-s-name').value.trim(), color: $('#at-s-color').value, source: subSource, reminder: $('#at-s-reminder').value, allday_reminder: $('#at-s-allday').checked, enabled: $('#at-s-enabled').checked };
    var users = checkedUsers('#at-s-user-list');
    if (editSub || users.length) body.users = users;
    if (subSource === 'url') {
      if ($('#at-s-url').value.trim()) body.url = $('#at-s-url').value.trim();
    } else {
      var idx = $('#at-s-target').value;
      body.target_index = idx === '' ? null : Number(idx);
      body.path = $('#at-s-path').value.trim();
      if ($('#at-s-user').value.trim()) body.username = $('#at-s-user').value.trim();
      if ($('#at-s-pass').value) body.password = $('#at-s-pass').value;
    }
    var btn = $('#at-s-save');
    btn.disabled = true;
    setMsg('#at-s-msg', T('common.saving'));
    var req = editSub ? A.api('PUT', 'subscriptions/' + editSub.id, body) : A.api('POST', 'subscriptions', body);
    req.then(function (r) {
      $('#at-s-url').value = '';
      $('#at-s-pass').value = '';
      A.closeModal('at-sub-modal');
      if (r.result && !r.result.ok) A.toast(T('refresh.saved_failed'), 'error'); else A.toast(T('common.saved'));
      return load();
    }).catch(function (e) { setMsg('#at-s-msg', errText(e), 'error'); }).then(function () { btn.disabled = false; });
  });
  $('#at-s-delete').addEventListener('click', function () {
    if (!editSub) return;
    var s = editSub;
    A.confirm(T('sub.delete_confirm', { name: s.name }), T('common.delete'), true).then(function (ok) {
      if (!ok) return;
      A.api('DELETE', 'subscriptions/' + s.id).then(function () { A.closeModal('at-sub-modal'); A.toast(T('common.deleted')); return load(); }).catch(warn);
    });
  });

  // ── test reminders ───────────────────────────────────────────────────────
  function sendTest(area, btn) {
    btn.disabled = true;
    A.api('POST', 'test/' + area).then(function (r) {
      if (r.ok) A.toast(r.pushed ? T('test.sent') : T('test.logged'));
      else A.toast(T('test.failed', { error: r.error || '' }), 'error');
    }).catch(warn).then(function () { btn.disabled = false; });
  }
  $('#at-waste-test').addEventListener('click', function () { sendTest('waste', this); });
  $('#at-cal-test').addEventListener('click', function () { sendTest('calendar', this); });

  load();
}());
