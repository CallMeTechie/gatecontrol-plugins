/* Logic chains page (port of GateControl's public/js/smarthome-rules.js). */
(function () {
  'use strict';
  var S = window.SH, T = S.T, $ = S.$, $$ = S.$$, el = S.el;
  var RULE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3v12"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9c0 7-12 5-12 9"/></svg>';
  // sensor reading → trigger kind of the rule translation (humidity/unknown have none)
  var TRIG = { presence: 'motion', open: 'contact', water: 'water', temperature: 'temperature', lightlevel: 'lux', button: 'button' };
  var EVENT_KINDS = ['motion', 'contact', 'water', 'button'];

  var gatewayId = null;
  var resources = [];
  var resById = {};
  var cancelSupported = true;
  var editingId = null;

  function fail(e) { S.toast((e && e.message) || String(e || T('common.error')), 'error'); }
  function resourceName(id) { var r = resById[id]; return r ? (r.name || ('#' + id)) : ('#' + id); }
  function trigType(r) { if (!r) return null; if (r.kind === 'switch') return 'button'; if (r.kind === 'sensor') return TRIG[r.capabilities && r.capabilities.reading] || null; return null; }
  function triggerResources() { return resources.filter(function (r) { return r.enabled && trigType(r); }); }
  function actionResources() { return resources.filter(function (r) { return r.enabled && ['light', 'plug', 'group', 'scene'].indexOf(r.kind) >= 0; }); }

  // sRGB hex → CIE xy (deCONZ colour lights take xy)
  function hexToXy(hex) {
    var n = parseInt(hex.slice(1), 16);
    var g = function (c) { return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92; };
    var r = g(((n >> 16) & 255) / 255), gg = g(((n >> 8) & 255) / 255), b = g((n & 255) / 255);
    var X = r * 0.4124 + gg * 0.3576 + b * 0.1805, Y = r * 0.2126 + gg * 0.7152 + b * 0.0722, Z = r * 0.0193 + gg * 0.1192 + b * 0.9505;
    var s = X + Y + Z || 1; return [+(X / s).toFixed(4), +(Y / s).toFixed(4)];
  }

  function trigLabel(t) {
    var n = resourceName(t.resourceId);
    switch (t.kind) {
      case 'motion': return n + ': ' + T(t.event === 'detected' ? 'val.motion' : 'val.idle');
      case 'contact': return n + ': ' + T(t.event === 'open' ? 'val.open' : 'val.closed');
      case 'water': return n + ': ' + T(t.event === 'wet' ? 'val.wet' : 'val.dry');
      case 'temperature': return n + ' ' + (t.op === 'lt' ? '<' : '>') + ' ' + t.value + ' °C';
      case 'lux': return n + ' ' + (t.op === 'lt' ? '<' : '>') + ' ' + t.value + ' lx';
      case 'button': return n + ': ' + T('rules.btn_' + (t.action || 'short'));
      default: return n;
    }
  }
  function actLabel(a) {
    var n = resourceName(a.resourceId);
    if (a.kind === 'scene') return n + ': ' + T('activate');
    var s = a.set || {}; var x = n;
    if (s.on === true) x += ': ' + T('rules.act_on'); else if (s.on === false) x += ': ' + T('rules.act_off');
    if ('bri' in s) x += ' · ' + s.bri + ' %';
    if ('color' in s) x += ' · ' + T('color');
    return x;
  }
  function flow(def) {
    def = def || {};
    var parts = [];
    (def.triggers || []).forEach(function (t) { parts.push(el('span', { class: 'pill pill-when', text: trigLabel(t) })); });
    parts.push(el('span', { class: 'arrow', text: '→' }));
    (def.actions || []).forEach(function (a) { parts.push(el('span', { class: 'pill pill-then', text: actLabel(a) })); });
    if (def.timeWindow && def.timeWindow.from && def.timeWindow.to) parts.push(el('span', { class: 'pill pill-time', text: def.timeWindow.from + '–' + def.timeWindow.to }));
    if (def.delay && def.delay.minutes) parts.push(el('span', { class: 'pill pill-time', text: '+' + def.delay.minutes + ' min' }));
    return el('div', { class: 'rule-flow' }, parts);
  }

  function ruleCard(r) {
    var ic = el('div', { class: 'rule-ic' });
    ic.innerHTML = RULE_ICON; // static markup
    var main = el('div', { class: 'rule-main' }, [el('div', { class: 'rule-name', text: r.name || '' }), flow(r.definition),
      r.orphaned ? el('div', { class: 'rule-warn', text: T('rules.orphaned_warn') }) : null]);
    var acts = el('div', { class: 'rule-acts' }, [
      r.orphaned ? null : el('button', { type: 'button', class: 'btn btn-sm', text: T('rules.edit'), on: { click: function () { openBuilder(r); } } }),
      el('button', { type: 'button', class: 'btn btn-sm', text: T('rules.delete'), on: { click: function () { deleteRule(r); } } }),
    ]);
    var tog = el('button', { type: 'button', class: 'sh-switch' + (r.enabled ? ' on' : ''), role: 'switch', 'aria-checked': r.enabled ? 'true' : 'false', 'aria-label': r.name || '', disabled: r.orphaned }, [el('i')]);
    if (!r.orphaned) tog.addEventListener('click', function () { toggleRule(r, tog); });
    return el('div', { class: 'sh-card rule-card' + (r.orphaned ? ' rule-orphaned' : '') }, [ic, main, acts, tog]);
  }

  function showLimit(msg) { var b = $('#shr-limit'); b.textContent = msg || ''; b.hidden = !msg; }
  function emptyMsg(txt) { var list = S.clear($('#shr-list')); list.appendChild(el('div', { class: 'sh-empty', text: txt })); }

  function loadGateways() {
    return S.api('GET', 'gateways').then(function (d) {
      var list = d.gateways || [];
      var sel = S.clear($('#shr-gateway'));
      list.forEach(function (g) { sel.appendChild(el('option', { value: String(g.id), text: g.name })); });
      sel.hidden = list.length < 2;
      var g = list.find(function (x) { return x.enabled; }) || list[0];
      gatewayId = g ? g.id : null;
      if (g) sel.value = String(g.id);
    }, function () { gatewayId = null; });
  }

  function loadRules() {
    $('#shr-count-hint').hidden = true;
    if (!gatewayId) { emptyMsg(T('empty')); return Promise.resolve(); }
    return S.api('GET', 'resources?gateway_id=' + gatewayId).then(function (rd) { resources = rd.resources || []; }, function () { resources = []; }).then(function () {
      resById = {}; resources.forEach(function (r) { resById[r.id] = r; });
      return S.api('GET', 'rules?gateway_id=' + gatewayId);
    }).then(function (data) {
      cancelSupported = data.cancelSupported !== false;
      showLimit(data.limit_warn ? T('rules.limit_warn') : null);
      if (!data.rules.length) { emptyMsg(T('rules.empty')); return; }
      var list = S.clear($('#shr-list'));
      data.rules.forEach(function (r) { list.appendChild(ruleCard(r)); });
    }, function () { emptyMsg(T('load_error')); });
  }

  function toggleRule(r, sw) {
    var on = !r.enabled;
    S.api('POST', 'rules/' + r.id + '/enabled', { enabled: on }).then(function () { r.enabled = on; sw.classList.toggle('on', on); sw.setAttribute('aria-checked', on ? 'true' : 'false'); }, fail);
  }
  function deleteRule(r) {
    S.confirm(T('rules.confirm_delete'), T('rules.delete'), true).then(function (ok) {
      if (ok) S.api('DELETE', 'rules/' + r.id).then(loadRules, fail);
    });
  }

  // ── Builder ──
  function makeSelect(cls, opts) {
    return el('select', { class: 'form-select ' + cls }, opts.map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
  }
  function makeNum(cls, ph) { return el('input', { type: 'number', class: 'form-input ' + cls, placeholder: ph || null, 'aria-label': ph || null }); }

  function renderTriggerFields(fields, r) {
    S.clear(fields); if (!r) return;
    var type = trigType(r);
    if (type === 'motion') fields.appendChild(makeSelect('shr-f-event', [['detected', T('val.motion')], ['ended', T('val.idle')]]));
    else if (type === 'contact') fields.appendChild(makeSelect('shr-f-event', [['open', T('val.open')], ['closed', T('val.closed')]]));
    else if (type === 'water') fields.appendChild(makeSelect('shr-f-event', [['wet', T('val.wet')], ['dry', T('val.dry')]]));
    else if (type === 'temperature' || type === 'lux') {
      fields.appendChild(makeSelect('shr-f-op', [['lt', T('rules.op_lt')], ['gt', T('rules.op_gt')]]));
      fields.appendChild(makeNum('shr-f-val', type === 'temperature' ? '°C' : 'lx'));
    } else if (type === 'button') {
      fields.appendChild(makeSelect('shr-f-btn', [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']]));
      fields.appendChild(makeSelect('shr-f-act', [['short', T('rules.btn_short')], ['long', T('rules.btn_long')], ['double', T('rules.btn_double')]]));
    }
  }
  function renderActionFields(fields, r) {
    S.clear(fields); if (!r || r.kind === 'scene') return;
    var caps = r.capabilities || {};
    var opts = [['on', T('rules.act_on')], ['off', T('rules.act_off')]];
    if (caps.bri) opts.push(['bri', T('brightness')]);
    if (caps.color && caps.color !== 'none') opts.push(['color', T('color')]);
    var op = makeSelect('shr-f-aop', opts); fields.appendChild(op);
    var extra = el('span', { class: 'shr-extra inline-row' }); fields.appendChild(extra);
    function renderExtra() {
      S.clear(extra);
      if (op.value === 'bri') { var b = makeNum('shr-f-bri', '%'); b.min = 0; b.max = 100; b.value = 100; extra.appendChild(b); }
      else if (op.value === 'color') {
        if (caps.color === 'ct') { var n = makeNum('shr-f-ct', 'ct'); n.min = 153; n.max = 500; n.value = 300; extra.appendChild(n); }
        else extra.appendChild(el('input', { type: 'color', class: 'shr-f-color', value: '#ffd27a', 'aria-label': T('color') }));
      }
    }
    op.addEventListener('change', renderExtra); renderExtra();
  }
  function rowSelect(list) {
    return el('select', { class: 'form-select shr-res' }, list.map(function (r) { return el('option', { value: String(r.id), text: r.name || ('#' + r.id) }); }));
  }
  function removeBtn(row, after) {
    return el('button', { type: 'button', class: 'btn row-x', text: '×', title: T('rules.delete'), 'aria-label': T('rules.delete'), on: { click: function () { row.remove(); if (after) after(); } } });
  }
  function addTriggerRow(pre) {
    var sel = rowSelect(triggerResources());
    var fields = el('div', { class: 'shr-fields' });
    var row = el('div', { class: 'shr-row' }, [sel, fields]);
    row.appendChild(removeBtn(row, updateMultiHint));
    var setRes = function () { row._res = resById[Number(sel.value)]; renderTriggerFields(fields, row._res); updateMultiHint(); };
    sel.addEventListener('change', setRes);
    if (pre && pre.resourceId != null) sel.value = String(pre.resourceId);
    $('#shr-when').appendChild(row); setRes();
    if (pre) {
      var set = function (c, v) { var x = fields.querySelector('.' + c); if (x && v != null) x.value = String(v); };
      set('shr-f-event', pre.event); set('shr-f-op', pre.op); set('shr-f-val', pre.value); set('shr-f-btn', pre.button); set('shr-f-act', pre.action);
    }
  }
  function addActionRow(pre) {
    var sel = rowSelect(actionResources());
    var fields = el('div', { class: 'shr-fields' });
    var row = el('div', { class: 'shr-row' }, [sel, fields]);
    row.appendChild(removeBtn(row));
    var setRes = function () { row._res = resById[Number(sel.value)]; renderActionFields(fields, row._res); };
    sel.addEventListener('change', setRes);
    if (pre && pre.resourceId != null) sel.value = String(pre.resourceId);
    $('#shr-then').appendChild(row); setRes();
    if (pre && pre.set) {
      var op = fields.querySelector('.shr-f-aop');
      if (op) {
        var s = pre.set; var v = 'on';
        if ('bri' in s) v = 'bri'; else if ('color' in s) v = 'color'; else if (s.on === false) v = 'off';
        op.value = v; op.dispatchEvent(new Event('change'));
        if (v === 'bri') { var b = fields.querySelector('.shr-f-bri'); if (b) b.value = s.bri; }
        else if (v === 'color' && s.color && s.color.ct != null) { var ct = fields.querySelector('.shr-f-ct'); if (ct) ct.value = s.color.ct; }
      }
    }
  }
  function updateMultiHint() {
    var n = $$('#shr-when .shr-row').filter(function (row) { return EVENT_KINDS.indexOf(trigType(row._res)) >= 0; }).length;
    $('#shr-multi-hint').hidden = n <= 1;
  }
  function applyCancelSupport() {
    var sel = $('#shr-onretrigger'); var opt = sel.querySelector('option[value="cancel"]');
    opt.disabled = !cancelSupported;
    opt.title = cancelSupported ? '' : T('rules.cancel_unsupported_hint');
    if (!cancelSupported && sel.value === 'cancel') sel.value = 'reset';
  }
  function openBuilder(rule) {
    editingId = rule ? rule.id : null;
    $('#shr-name').value = rule ? (rule.name || '') : '';
    $('#shr-from').value = ''; $('#shr-to').value = ''; $('#shr-delay-min').value = ''; $('#shr-onretrigger').value = 'ignore';
    S.clear($('#shr-when')); S.clear($('#shr-then'));
    var def = rule && rule.definition;
    if (def) {
      (def.triggers || []).forEach(function (t) { addTriggerRow(t); });
      (def.actions || []).forEach(function (a) { addActionRow(a); });
      if (def.timeWindow) { $('#shr-from').value = def.timeWindow.from || ''; $('#shr-to').value = def.timeWindow.to || ''; }
      if (def.delay) { $('#shr-delay-min').value = def.delay.minutes || ''; $('#shr-onretrigger').value = def.delay.onRetrigger || 'ignore'; }
    } else { addTriggerRow(); addActionRow(); }
    applyCancelSupport();
    updateMultiHint();
    S.openModal('shr-modal');
  }
  function readTrigger(row) {
    var r = row._res; if (!r) return null; var type = trigType(r);
    var g = function (c) { return row.querySelector('.' + c); };
    if (type === 'motion' || type === 'contact' || type === 'water') return { kind: type, resourceId: r.id, event: g('shr-f-event').value };
    if (type === 'temperature' || type === 'lux') return { kind: type, resourceId: r.id, op: g('shr-f-op').value, value: Number(g('shr-f-val').value) };
    if (type === 'button') return { kind: 'button', resourceId: r.id, button: Number(g('shr-f-btn').value), action: g('shr-f-act').value };
    return null;
  }
  function readAction(row) {
    var r = row._res; if (!r) return null;
    if (r.kind === 'scene') return { kind: 'scene', resourceId: r.id };
    var opEl = row.querySelector('.shr-f-aop'); var op = opEl ? opEl.value : 'on';
    var a = { kind: r.kind, resourceId: r.id, set: {} };
    if (op === 'on') a.set.on = true;
    else if (op === 'off') a.set.on = false;
    else if (op === 'bri') a.set.bri = Number(row.querySelector('.shr-f-bri').value);
    else if (op === 'color') {
      if ((r.capabilities || {}).color === 'ct') a.set.color = { ct: Number(row.querySelector('.shr-f-ct').value) };
      else a.set.color = { xy: hexToXy(row.querySelector('.shr-f-color').value) };
    }
    return a;
  }
  function buildDefinition() {
    var def = { triggers: [], actions: [] };
    $$('#shr-when .shr-row').forEach(function (row) { var t = readTrigger(row); if (t) def.triggers.push(t); });
    $$('#shr-then .shr-row').forEach(function (row) { var a = readAction(row); if (a) def.actions.push(a); });
    var from = $('#shr-from').value, to = $('#shr-to').value;
    if (from && to) def.timeWindow = { from: from, to: to };
    var mins = parseInt($('#shr-delay-min').value, 10);
    if (mins > 0) def.delay = { minutes: mins, onRetrigger: $('#shr-onretrigger').value };
    return def;
  }
  function saveRule() {
    var name = $('#shr-name').value.trim();
    if (!name) { fail(T('rules.name_required')); return; }
    var definition = buildDefinition();
    var p = editingId ? S.api('PUT', 'rules/' + editingId, { name: name, definition: definition })
      : S.api('POST', 'rules', { gateway_id: gatewayId, name: name, definition: definition });
    p.then(function () { S.closeModal('shr-modal'); return loadRules(); }, function (e) {
      if (e && e.status === 409) { S.closeModal('shr-modal'); showLimit(e.message); return; } // rule limit / no api key → banner
      fail(e);
    });
  }
  function loadCount() {
    if (!gatewayId) return;
    S.api('GET', 'rules/gateway-count?gateway_id=' + gatewayId).then(function (d) {
      var h = $('#shr-count-hint');
      h.textContent = T('rules.count_total') + ': ' + d.total_rules + ' · ' + T('rules.count_gc') + ': ' + d.gc_rules + ' · ' + T('rules.count_external') + ': ' + d.external_rules;
      h.hidden = false;
    }, fail);
  }

  $('#shr-new').addEventListener('click', function () { if (gatewayId) openBuilder(null); });
  $('#shr-save').addEventListener('click', saveRule);
  $('#shr-add-when').addEventListener('click', function () { addTriggerRow(); });
  $('#shr-add-then').addEventListener('click', function () { addActionRow(); });
  $('#shr-gateway-count').addEventListener('click', loadCount);
  $('#shr-gateway').addEventListener('change', function () { gatewayId = Number($('#shr-gateway').value) || null; loadRules(); });
  loadGateways().then(loadRules);
}());
