/* Logic chains page (port of GateControl's public/js/smarthome-rules.js). Sources: deCONZ gateways (rules on the
   gateway, the builder as before) and GateControl gateways with Shelly / Tasmota devices (chains in the plugin's edge
   part on that gateway, server/edgerules.js). Since 1.11.0 the start view is "Alle Quellen", grouped by place; a chain
   on a GateControl gateway is edited in the new editor (WENN · NUR WENN · DANN, version 2), has a Testlauf and a
   Protokoll; a version 1 chain opens there as "wird wahr: A und B" and is saved as version 2. */
(function () {
  'use strict';
  var S = window.SH, T = S.T, $ = S.$, $$ = S.$$, el = S.el;
  var RULE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3v12"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9c0 7-12 5-12 9"/></svg>';
  var STOP_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';
  // sensor reading → trigger kind of the rule translation (humidity/unknown have none)
  var TRIG = { presence: 'motion', open: 'contact', water: 'water', temperature: 'temperature', lightlevel: 'lux', button: 'button' };
  var EVENT_KINDS = ['motion', 'contact', 'water', 'button'];
  var MAX_EDGE = 40;
  var MAX_STEPS = 20;
  var DAY_PRESETS = [['1,2,3,4,5', 'chain.days_workdays'], ['6,7', 'chain.days_weekend'], ['1,2,3,4,5,6,7', 'chain.days_every']];

  // the deCONZ builder works on one source at a time (as before)
  var gatewayId = null;
  var sourceType = 'd';         // 'd' a deCONZ gateway | 'e' a GateControl gateway (Shelly / Tasmota)
  var resources = [];
  var resById = {};
  var cancelSupported = true;
  var editingId = null;

  var deconzGws = [];
  var edgeGws = [];
  var sources = {};             // 'd:1' | 'e:7' → { key, type, id, name, gw, resources, resById, devices, devById, rules, … }
  var current = 'all';          // 'all' | a source key
  var view = 'list';            // 'list' | 'log'

  function fail(e) { S.toast((e && e.message) || String(e || T('common.error')), 'error'); }
  function resourceName(id) { var r = resById[id]; return r ? (r.name || ('#' + id)) : ('#' + id); }
  function isEdge(r) { return !!(r && r.capabilities && r.capabilities.source === 'edge'); }
  /** What a Shelly / Tasmota channel can trigger on: state (on/off), cover (open/closed), power, temperature, humidity. */
  function edgeTrigKinds(r) {
    var caps = r.capabilities || {}; var st = r.state || {}; var out = [];
    if (r.kind === 'light' || r.kind === 'plug' || r.kind === 'relay') out.push('state');
    if (r.kind === 'cover' && caps.position) out.push('cover');
    if (r.kind !== 'sensor' && caps.power) out.push('power');
    if (r.kind === 'sensor') {
      if (caps.reading === 'temperature') out.push('temperature');
      if (caps.reading === 'humidity' || st.humidity != null) out.push('humidity');
    }
    return out;
  }
  function trigType(r) {
    if (!r) return null;
    if (isEdge(r)) return edgeTrigKinds(r)[0] || null;
    if (r.kind === 'switch') return 'button';
    if (r.kind === 'sensor') return TRIG[r.capabilities && r.capabilities.reading] || null;
    return null;
  }
  function triggerResources() { return resources.filter(function (r) { return r.enabled && trigType(r); }); }
  function actionResources() { return resources.filter(function (r) { return r.enabled && (sourceType === 'e' ? ['light', 'plug', 'relay', 'cover'] : ['light', 'plug', 'group', 'scene']).indexOf(r.kind) >= 0; }); }
  var UNITS = { power: 'W', temperature: '°C', humidity: '%' };

  // sRGB hex → CIE xy (deCONZ colour lights take xy)
  function hexToXy(hex) {
    var n = parseInt(hex.slice(1), 16);
    var g = function (c) { return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92; };
    var r = g(((n >> 16) & 255) / 255), gg = g(((n >> 8) & 255) / 255), b = g((n & 255) / 255);
    var X = r * 0.4124 + gg * 0.3576 + b * 0.1805, Y = r * 0.2126 + gg * 0.7152 + b * 0.0722, Z = r * 0.0193 + gg * 0.1192 + b * 0.9505;
    var s = X + Y + Z || 1; return [+(X / s).toFixed(4), +(Y / s).toFixed(4)];
  }

  // ── Labels (deCONZ rules: as before) ──
  function trigLabel(t) {
    var n = resourceName(t.resourceId);
    switch (t.kind) {
      case 'motion': return n + ': ' + T(t.event === 'detected' ? 'val.motion' : 'val.idle');
      case 'contact': return n + ': ' + T(t.event === 'open' ? 'val.open' : 'val.closed');
      case 'water': return n + ': ' + T(t.event === 'wet' ? 'val.wet' : 'val.dry');
      case 'temperature': return n + ' ' + (t.op === 'lt' ? '<' : '>') + ' ' + t.value + ' °C';
      case 'humidity': return n + ' ' + (t.op === 'lt' ? '<' : '>') + ' ' + t.value + ' %';
      case 'power': return n + ' ' + (t.op === 'lt' ? '<' : '>') + ' ' + t.value + ' W';
      case 'state': return n + ': ' + T(t.event === 'on' ? 'rules.act_on' : 'rules.act_off');
      case 'cover': return n + ': ' + T(t.event === 'open' ? 'val.open' : 'val.closed');
      case 'lux': return n + ' ' + (t.op === 'lt' ? '<' : '>') + ' ' + t.value + ' lx';
      case 'button': return n + ': ' + T('rules.btn_' + (t.action || 'short'));
      default: return n;
    }
  }
  function actLabel(a) {
    var n = resourceName(a.resourceId);
    if (a.kind === 'scene') return n + ': ' + T('activate');
    var s = a.set || {}; var x = n;
    if (s.cover) return n + ': ' + T('cover.' + s.cover);
    if ('pos' in s) return n + ': ' + T('cover.pos_open', { pos: s.pos });
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

  // ── Labels (chains on a GateControl gateway, version 2) ──
  function nameIn(src, id) { var r = src && src.resById[id]; return r ? (r.name || ('#' + id)) : T('chain.missing'); }
  function devName(src, id) { var d = src && src.devById[id]; return d ? d.name : T('chain.missing'); }
  function num(v) { return String(v).replace('.', T('chain.decimal')); }
  function valueText(kind, op, value) { return T(op === 'lt' ? 'rules.op_lt' : 'rules.op_gt') + ' ' + num(value) + ' ' + (UNITS[kind] || ''); }
  function daysLabel(days) {
    var key = (days || []).slice().sort().join(',');
    for (var i = 0; i < DAY_PRESETS.length; i++) if (DAY_PRESETS[i][0] === key) return T(DAY_PRESETS[i][1]);
    return (days || []).map(function (d) { return T('chain.day_' + d); }).join(', ');
  }
  function durLabel(sec) {
    if (sec % 3600 === 0) return T('chain.dur_h', { n: sec / 3600 });
    if (sec % 60 === 0) return T('chain.dur_min', { n: sec / 60 });
    if (sec < 60) return T('chain.dur_s', { n: sec });
    return T('chain.dur_min_s', { m: Math.floor(sec / 60), s: sec % 60 });
  }
  /** A device state as a condition: "Stehlampe ist aus", "Waschmaschine unter 5 W". */
  function condLabel(c, src) {
    if (c.kind === 'time') return T('chain.between', { from: c.from, to: c.to });
    if (c.kind === 'days') return daysLabel(c.days);
    var n = nameIn(src, c.resourceId);
    if (c.kind === 'state') return T(c.is === 'on' ? 'chain.is_on' : 'chain.is_off', { n: n });
    if (c.kind === 'cover') return T(c.is === 'open' ? 'chain.is_open' : 'chain.is_closed', { n: n });
    return n + ' ' + valueText(c.kind, c.op, c.value);
  }
  function partLabel(t, src) {
    if (t.kind === 'state' || t.kind === 'cover') return condLabel({ kind: t.kind, resourceId: t.resourceId, is: t.event }, src);
    return condLabel(t, src);
  }
  /** A trigger (an event): "Flur geht an", "Taster · Taste 2 kurz", "um 07:00", "wird wahr: A und B". */
  function whenLabel(t, src) {
    if (!t) return '';
    if (t.kind === 'button') return T('chain.button_label', { n: devName(src, t.deviceId), key: t.input + 1, ev: T('chain.press_' + t.event) });
    if (t.kind === 'time') return T('chain.at', { time: t.at });
    if (t.kind === 'all') return T('chain.becomes', { list: (t.parts || []).map(function (p) { return partLabel(p, src); }).join(' ' + T('chain.and') + ' ') });
    var n = nameIn(src, t.resourceId);
    if (t.kind === 'state') return T(t.event === 'on' ? 'chain.goes_on' : 'chain.goes_off', { n: n });
    if (t.kind === 'cover') return T(t.event === 'open' ? 'chain.goes_open' : 'chain.goes_closed', { n: n });
    return T('chain.crosses', { n: n, what: valueText(t.kind, t.op, t.value) });
  }
  function stepLabel(s, src) {
    if (!s) return '';
    if (s.kind === 'wait') return durLabel(s.seconds);
    var n = nameIn(src, s.resourceId); var set = s.set || {};
    if (set.cover) return n + ' ' + T('cover.' + set.cover);
    if ('pos' in set) return n + ' ' + T('cover.pos_open', { pos: set.pos });
    if ('bri' in set) return T('chain.on_bri', { n: n, bri: set.bri });
    return n + ' ' + T(set.on ? 'rules.act_on' : 'rules.act_off');
  }
  function flowV2(def, src) {
    var parts = [];
    (def.triggers || []).forEach(function (t, i) {
      if (i) parts.push(el('span', { class: 'arrow', text: T('chain.or') }));
      parts.push(el('span', { class: 'pill pill-when', text: whenLabel(t, src) }));
    });
    var conds = (def.conditions && def.conditions.list) || [];
    if (conds.length) {
      parts.push(el('span', { class: 'arrow', text: T(def.conditions.mode === 'any' ? 'chain.if_any_short' : 'chain.if_short') }));
      conds.forEach(function (c) { parts.push(el('span', { class: 'pill pill-if', text: condLabel(c, src) })); });
    }
    parts.push(el('span', { class: 'arrow', text: '→' }));
    (def.steps || []).forEach(function (s) { parts.push(el('span', { class: 'pill ' + (s.kind === 'wait' ? 'pill-time' : 'pill-then'), text: stepLabel(s, src) })); });
    return el('div', { class: 'rule-flow' }, parts);
  }
  function clockOf(iso) {
    var d = new Date(iso);
    return isFinite(d) ? String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : '';
  }

  // ── Sources ──
  function srcList() {
    return edgeGws.map(function (g) { return 'e:' + g.id; }).concat(deconzGws.map(function (g) { return 'd:' + g.id; }));
  }
  function loadGateways() {
    return Promise.all([
      S.api('GET', 'gateways').catch(function () { return { gateways: [] }; }),
      S.api('GET', 'edge/gateways').catch(function () { return { gateways: [] }; }),
    ]).then(function (out) {
      deconzGws = out[0].gateways || [];
      // every GateControl gateway the edge part is set up for (a gateway that is away keeps its rules)
      edgeGws = ((out[1] && out[1].gateways) || []).filter(function (g) { return !g.tooOld; });
      var sel = S.clear($('#shr-gateway'));
      sel.appendChild(el('option', { value: 'all', text: T('chain.all_sources') }));
      if (edgeGws.length) sel.appendChild(el('optgroup', { label: T('chain.group_gc') }, edgeGws.map(function (g) { return el('option', { value: 'e:' + g.id, text: g.name }); })));
      if (deconzGws.length) sel.appendChild(el('optgroup', { label: T('source.group_deconz') }, deconzGws.map(function (g) { return el('option', { value: 'd:' + g.id, text: g.name }); })));
      sel.hidden = deconzGws.length + edgeGws.length < 2;
      sources = {};
      edgeGws.forEach(function (g) { sources['e:' + g.id] = { key: 'e:' + g.id, type: 'e', id: g.id, name: g.name, gw: g, rules: null }; });
      deconzGws.forEach(function (g) { sources['d:' + g.id] = { key: 'd:' + g.id, type: 'd', id: g.id, name: g.name, gw: g, rules: null }; });
      if (current !== 'all' && !sources[current]) current = 'all';
      sel.value = current;
    });
  }
  /** Resources, devices and rules of one source. */
  function loadSource(src) {
    var edge = src.type === 'e';
    var load = edge
      ? S.api('GET', 'edge/devices?gateway_id=' + src.id).then(function (rd) {
        src.devices = rd.devices || [];
        src.resources = [];
        src.devices.forEach(function (d) { (d.resources || []).forEach(function (r) { src.resources.push(r); }); });
      })
      : S.api('GET', 'resources?gateway_id=' + src.id).then(function (rd) { src.devices = []; src.resources = rd.resources || []; });
    return load.catch(function () { src.devices = src.devices || []; src.resources = src.resources || []; }).then(function () {
      src.resById = {}; src.resources.forEach(function (r) { src.resById[r.id] = r; });
      src.devById = {}; src.devices.forEach(function (d) { src.devById[d.id] = d; });
      return S.api('GET', 'rules?gateway_id=' + src.id + (edge ? '&source=edge' : ''));
    }).then(function (data) {
      src.rules = data.rules || [];
      src.cancelSupported = data.cancelSupported !== false;
      src.limitWarn = !!data.limit_warn;
      src.error = false;
    }, function () { src.rules = []; src.error = true; });
  }
  function shown() { return current === 'all' ? srcList() : [current]; }
  function reload() {
    $('#shr-count-hint').hidden = true;
    var keys = view === 'log' ? srcList().filter(function (k) { return k.charAt(0) === 'e'; }) : shown();
    return Promise.all(keys.map(function (k) { return sources[k] ? loadSource(sources[k]) : null; })).then(function () {
      if (view === 'log') renderLog(); else renderList();
    });
  }
  var loadRules = reload; // the deCONZ builder reloads with it

  function showLimit(msg) { var b = $('#shr-limit'); b.textContent = msg || ''; b.hidden = !msg; }
  function emptyMsg(host, txt) { host.appendChild(el('div', { class: 'sh-empty', text: txt })); }

  function sourceHint() {
    var h = $('#shr-source-hint');
    var src = sources[current];
    $('#shr-gateway-count').hidden = !(src && src.type === 'd');
    if (!edgeGws.length || (src && src.type === 'd')) { h.hidden = true; return; }
    var away = src ? src.gw.state !== 'running' : false;
    h.textContent = T('chain.banner') + (away ? ' ' + T('rules.edge_away') : '');
    h.hidden = false;
  }

  // ── List ──
  function ruleCard(r, src) {
    var edge = src.type === 'e';
    var stopped = edge && r.stopped;
    var ic = el('div', { class: 'rule-ic' });
    ic.innerHTML = stopped ? STOP_ICON : RULE_ICON; // static markup
    var pill = stopped ? el('span', { class: 'sh-pill is-crit', text: T('chain.stopped') })
      : el('span', { class: 'sh-pill ' + (edge ? 'is-good' : 'is-info'), text: T(edge ? 'chain.runs_gateway' : 'chain.runs_deconz') });
    var last = null;
    if (edge && !r.orphaned) {
      var txt = r.last_fired_at ? T('rules.last_fired', { ago: S.since(r.last_fired_at) }) : (r.runs_today ? '' : T('rules.never_fired'));
      if (r.runs_today) txt += (txt ? ' · ' : '') + T('chain.today_n', { n: r.runs_today });
      last = el('div', { class: 'rule-last', text: txt });
    }
    var main = el('div', { class: 'rule-main' }, [
      el('div', { class: 'rule-name' }, [r.name || '', pill]),
      edge ? flowV2(r.v2 || {}, src) : flowWith(src, r.definition),
      r.orphaned ? el('div', { class: 'rule-warn', text: T('rules.orphaned_warn') }) : null,
      stopped ? el('div', { class: 'rule-crit', text: T('chain.stopped_why', { time: clockOf(r.stopped.at), n: stoppedCount(r.stopped.reason), max: 10 }) }) : null,
      stopped ? null : last,
    ]);
    var btn = function (key, fn) { return el('button', { type: 'button', class: 'btn btn-sm', text: T(key), on: { click: fn } }); };
    var acts = el('div', { class: 'rule-acts' }, stopped ? [
      btn('chain.log', function () { openLog(r.id, null); }),
      btn('chain.restart', function () { setEnabled(r, true); }),
    ] : [
      edge && !r.orphaned && r.enabled ? btn('chain.test_btn', function () { openLog(r.id, r); }) : null,
      r.orphaned ? null : btn('rules.edit', function () { if (edge) openEditor(src, r); else openBuilderFor(src, r); }),
      btn('rules.delete', function () { deleteRule(r); }),
    ]);
    var tog = el('button', { type: 'button', class: 'sh-switch' + (r.enabled ? ' on' : ''), role: 'switch', 'aria-checked': r.enabled ? 'true' : 'false', 'aria-label': r.name || '', disabled: r.orphaned }, [el('i')]);
    if (!r.orphaned) tog.addEventListener('click', function () { setEnabled(r, !r.enabled); });
    return el('div', { class: 'sh-card rule-card' + (r.orphaned ? ' rule-orphaned' : '') + (stopped ? ' is-stopped' : (!r.enabled ? ' is-off' : '')) }, [ic, main, acts, tog]);
  }
  function stoppedCount(reason) { var m = /^rate:(\d+)$/.exec(reason || ''); return m ? Number(m[1]) : 11; }
  /** The deCONZ flow uses the builder's resource names: those of its source. */
  function flowWith(src, def) {
    var keep = resById; resById = src.resById || {};
    try { return flow(def); } finally { resById = keep; }
  }
  function groupTitle(src) {
    var n = (src.rules || []).length;
    var small = src.type === 'e'
      ? T('chain.group_edge', { n: n, max: MAX_EDGE }) + ' · ' + T(src.gw.state === 'running' ? 'chain.connected' : 'chain.not_connected')
      : T('chain.group_deconz', { n: n });
    return el('div', { class: 'group-title' }, [src.name, el('small', { text: small }), el('span', { class: 'ln' })]);
  }
  function renderList() {
    sourceHint();
    var host = S.clear($('#shr-list'));
    var keys = shown();
    if (!keys.length) { emptyMsg(host, T('empty')); return; }
    var any = false;
    var warn = false;
    keys.forEach(function (k) {
      var src = sources[k];
      if (!src || !src.rules) return;
      if (src.type === 'd' && src.limitWarn) warn = true;
      if (current === 'all') { if (!src.rules.length) return; host.appendChild(groupTitle(src)); }
      if (src.error) { emptyMsg(host, T('load_error')); return; }
      var list = el('div', { class: 'rule-list' });
      src.rules.forEach(function (r) { list.appendChild(ruleCard(r, src)); });
      if (src.rules.length) { host.appendChild(list); any = true; }
    });
    showLimit(warn ? T('rules.limit_warn') : null);
    if (!any) emptyMsg(host, T('chain.empty'));
  }

  function findRule(id) {
    var out = null;
    Object.keys(sources).forEach(function (k) { (sources[k].rules || []).forEach(function (r) { if (r.id === id) out = { rule: r, src: sources[k] }; }); });
    return out;
  }
  function setEnabled(r, on) {
    S.api('POST', 'rules/' + r.id + '/enabled', { enabled: on }).then(function () { return reload(); }, fail);
  }
  function deleteRule(r) {
    S.confirm(T('chain.confirm_delete'), T('rules.delete'), true).then(function (ok) {
      if (ok) S.api('DELETE', 'rules/' + r.id).then(reload, fail);
    });
  }
  /** The deCONZ builder for one source (its resources, its gateway). */
  function useSource(src) {
    sourceType = src.type; gatewayId = src.id;
    resources = src.resources || []; resById = src.resById || {};
    cancelSupported = src.cancelSupported !== false;
  }
  function openBuilderFor(src, rule, name) {
    useSource(src);
    openBuilder(rule || null);
    if (name) $('#shr-name').value = name.slice(0, 20);
  }

  // ── Builder ──
  function makeSelect(cls, opts) {
    return el('select', { class: 'form-select ' + cls }, opts.map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
  }
  function makeNum(cls, ph) { return el('input', { type: 'number', class: 'form-input ' + cls, placeholder: ph || null, 'aria-label': ph || null }); }

  /** Shelly / Tasmota: what of the channel triggers (state, power, …), then the fields of that choice. */
  function renderEdgeTriggerFields(fields, r, pre) {
    var kinds = edgeTrigKinds(r);
    var what = makeSelect('shr-f-what', kinds.map(function (k) { return [k, T('rules.what_' + k)]; }));
    what.setAttribute('aria-label', T('rules.what'));
    what.hidden = kinds.length < 2;
    var rest = el('span', { class: 'shr-extra inline-row' });
    fields.appendChild(what); fields.appendChild(rest);
    function renderRest() {
      S.clear(rest);
      var k = what.value;
      if (k === 'state') rest.appendChild(makeSelect('shr-f-event', [['on', T('rules.act_on')], ['off', T('rules.act_off')]]));
      else if (k === 'cover') rest.appendChild(makeSelect('shr-f-event', [['open', T('val.open')], ['closed', T('val.closed')]]));
      else {
        rest.appendChild(makeSelect('shr-f-op', [['lt', T('rules.op_lt')], ['gt', T('rules.op_gt')]]));
        var n = makeNum('shr-f-val', UNITS[k]); n.step = 'any'; rest.appendChild(n);
      }
      updateMultiHint();
    }
    what.addEventListener('change', renderRest);
    if (pre && kinds.indexOf(pre.kind) >= 0) what.value = pre.kind;
    renderRest();
  }
  function renderTriggerFields(fields, r, pre) {
    S.clear(fields); if (!r) return;
    if (isEdge(r)) { renderEdgeTriggerFields(fields, r, pre); return; }
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
    if (r.kind === 'cover') {
      // a shutter, awning or gate (Shelly / Tasmota): open, close, stop, or a position
      var copts = [['open', T('cover.open')], ['close', T('cover.close')], ['stop', T('cover.stop')]];
      if (caps.position) copts.push(['pos', T('cover.position')]);
      var cop = makeSelect('shr-f-aop', copts); fields.appendChild(cop);
      var cextra = el('span', { class: 'shr-extra inline-row' }); fields.appendChild(cextra);
      var renderCover = function () {
        S.clear(cextra);
        if (cop.value === 'pos') { var p = makeNum('shr-f-pos', '%'); p.min = 0; p.max = 100; p.value = 50; cextra.appendChild(p); }
      };
      cop.addEventListener('change', renderCover); renderCover();
      return;
    }
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
    var setRes = function (first) { row._res = resById[Number(sel.value)]; renderTriggerFields(fields, row._res, first === true ? pre : null); updateMultiHint(); };
    sel.addEventListener('change', setRes);
    if (pre && pre.resourceId != null) sel.value = String(pre.resourceId);
    $('#shr-when').appendChild(row); setRes(true);
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
        if (s.cover) v = s.cover; else if ('pos' in s) v = 'pos';
        else if ('bri' in s) v = 'bri'; else if ('color' in s) v = 'color'; else if (s.on === false) v = 'off';
        op.value = v; op.dispatchEvent(new Event('change'));
        if (v === 'pos') { var ps = fields.querySelector('.shr-f-pos'); if (ps) ps.value = s.pos; }
        else if (v === 'bri') { var b = fields.querySelector('.shr-f-bri'); if (b) b.value = s.bri; }
        else if (v === 'color' && s.color && s.color.ct != null) { var ct = fields.querySelector('.shr-f-ct'); if (ct) ct.value = s.color.ct; }
      }
    }
  }
  function updateMultiHint() {
    // Shelly / Tasmota: every trigger is a state the rule waits for; deCONZ: the event triggers
    var n = $$('#shr-when .shr-row').filter(function (row) { return isEdge(row._res) || EVENT_KINDS.indexOf(trigType(row._res)) >= 0; }).length;
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
    if (isEdge(r)) {
      var k = g('shr-f-what') ? g('shr-f-what').value : type;
      if (k === 'state' || k === 'cover') return { kind: k, resourceId: r.id, event: g('shr-f-event').value };
      return { kind: k, resourceId: r.id, op: g('shr-f-op').value, value: Number(g('shr-f-val').value) };
    }
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
    if (r.kind === 'cover') {
      if (op === 'pos') a.set.pos = Number(row.querySelector('.shr-f-pos').value); else a.set.cover = op;
      return a;
    }
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
    p.then(function () { S.closeModal('shr-modal'); return reload(); }, function (e) {
      if (e && e.status === 409) { S.closeModal('shr-modal'); showLimit(e.message); return; } // rule limit / no api key → banner
      fail(e);
    });
  }
  function loadCount() {
    var src = sources[current];
    if (!src || src.type !== 'd') return;
    S.api('GET', 'rules/gateway-count?gateway_id=' + src.id).then(function (d) {
      var h = $('#shr-count-hint');
      h.textContent = T('rules.count_total') + ': ' + d.total_rules + ' · ' + T('rules.count_gc') + ': ' + d.gc_rules + ' · ' + T('rules.count_external') + ': ' + d.external_rules;
      h.hidden = false;
    }, fail);
  }

  // ── Editor of a chain on a GateControl gateway (version 2) ──
  var ed = { src: null, rule: null, mode: 'all', timer: null, seq: 0, loop: null };

  function opt(v, label) { return el('option', { value: v, text: label }); }
  function sel(cls, label, opts) {
    return el('select', { class: 'form-select ' + cls, 'aria-label': label }, opts.map(function (o) { return opt(o[0], o[1]); }));
  }
  function numInput(cls, label, value) {
    var n = el('input', { type: 'number', class: 'form-input f-sm ' + cls, 'aria-label': label, step: 'any' });
    if (value != null) n.value = String(value);
    return n;
  }
  function xBtn(row) {
    return el('button', { type: 'button', class: 'btn row-x', text: '×', 'aria-label': T('chain.remove'), on: { click: function () { row.remove(); edChanged(); } } });
  }
  function trigResources(src) { return (src.resources || []).filter(function (r) { return r.enabled && edgeTrigKinds(r).length; }); }
  function actResources(src) { return (src.resources || []).filter(function (r) { return r.enabled && ['light', 'plug', 'relay', 'cover'].indexOf(r.kind) >= 0; }); }
  /** Taster (the devices) and the channels that report a state; extra options in front (conditions: time, days). */
  function deviceSelect(src, buttons, extra) {
    var s = el('select', { class: 'form-select dev', 'aria-label': T('chain.device') });
    (extra || []).forEach(function (o) { s.appendChild(opt(o[0], o[1])); });
    if (buttons && (src.devices || []).length) s.appendChild(el('optgroup', { label: T('chain.group_buttons') }, src.devices.map(function (d) { return opt('b:' + d.id, d.name); })));
    var rl = trigResources(src);
    if (rl.length) s.appendChild(el('optgroup', { label: T('chain.group_devices') }, rl.map(function (r) { return opt('r:' + r.id, r.name || ('#' + r.id)); })));
    return s;
  }
  /** What of a channel: state / position / power / … then its fields (a trigger: "geht an"; a condition: "ist an"). */
  function channelFields(host, r, pre, asCond) {
    var kinds = edgeTrigKinds(r);
    var what = sel('f f-what', T('rules.what'), kinds.map(function (k) { return [k, T('rules.what_' + k)]; }));
    what.hidden = kinds.length < 2;
    var rest = el('span', { class: 'f-rest' });
    host.appendChild(what); host.appendChild(rest);
    var render = function () {
      S.clear(rest);
      var k = what.value;
      if (k === 'state') rest.appendChild(sel('f f-ev', T('chain.event'), asCond ? [['on', T('chain.st_is_on')], ['off', T('chain.st_is_off')]] : [['on', T('chain.st_goes_on')], ['off', T('chain.st_goes_off')]]));
      else if (k === 'cover') rest.appendChild(sel('f f-ev', T('chain.event'), asCond ? [['open', T('chain.st_is_open')], ['closed', T('chain.st_is_closed')]] : [['open', T('chain.st_goes_open')], ['closed', T('chain.st_goes_closed')]]));
      else {
        rest.appendChild(sel('f f-op', T('chain.op'), [['gt', T('rules.op_gt')], ['lt', T('rules.op_lt')]]));
        rest.appendChild(numInput('f-val', UNITS[k]));
        rest.appendChild(el('span', { class: 'form-hint', text: UNITS[k] }));
      }
    };
    what.addEventListener('change', function () { render(); edChanged(); });
    if (pre && kinds.indexOf(pre.kind) >= 0) what.value = pre.kind;
    render();
    if (pre) {
      var ev = rest.querySelector('.f-ev'); var v = asCond ? pre.is : pre.event;
      if (ev && v) ev.value = v;
      var op = rest.querySelector('.f-op'); if (op && pre.op) op.value = pre.op;
      var val = rest.querySelector('.f-val'); if (val && pre.value != null) val.value = String(pre.value);
    }
  }
  function readChannel(row, r, asCond) {
    var k = row.querySelector('.f-what').value;
    var ev = row.querySelector('.f-ev');
    if (k === 'state' || k === 'cover') return asCond ? { kind: k, resourceId: r.id, is: ev.value } : { kind: k, resourceId: r.id, event: ev.value };
    return { kind: k, resourceId: r.id, op: row.querySelector('.f-op').value, value: Number(row.querySelector('.f-val').value) };
  }

  function addWhen(pre) {
    var src = ed.src;
    var row = el('div', { class: 'row' });
    if (pre && pre.kind === 'time') {
      var at = el('input', { type: 'time', class: 'form-input f-sm f-at', 'aria-label': T('chain.time'), value: pre.at || '07:00' });
      row.appendChild(el('span', { class: 'step-kind', text: T('chain.time') }));
      row.appendChild(at);
      row.appendChild(el('span', { class: 'form-hint', text: T('chain.time_hint') }));
      row._read = function () { return at.value ? { kind: 'time', at: at.value } : null; };
    } else if (pre && pre.kind === 'all') {
      // a version 1 chain: its triggers together ("wird wahr: A und B"), kept as they are
      row.appendChild(el('span', { class: 'pill pill-when chain-all', text: whenLabel(pre, src) }));
      row._read = function () { return pre; };
    } else {
      var s = deviceSelect(src, true);
      var fields = el('span', { class: 'chain-fields' });
      row.appendChild(s); row.appendChild(fields);
      var render = function (p) {
        S.clear(fields);
        var v = s.value || '';
        if (v.charAt(0) === 'b') {
          fields.appendChild(sel('f f-key', T('chain.key'), [0, 1, 2, 3].map(function (i) { return [String(i), T('chain.key_n', { n: i + 1 })]; })));
          fields.appendChild(sel('f f-press', T('chain.event'), [['single', T('chain.press_single')], ['double', T('chain.press_double')], ['triple', T('chain.press_triple')], ['long', T('chain.press_long')]]));
          if (p) { fields.querySelector('.f-key').value = String(p.input || 0); fields.querySelector('.f-press').value = p.event || 'single'; }
        } else if (v.charAt(0) === 'r') channelFields(fields, src.resById[Number(v.slice(2))], p, false);
        tasmotaHint();
      };
      if (pre && pre.kind === 'button') s.value = 'b:' + pre.deviceId;
      else if (pre && pre.resourceId != null) s.value = 'r:' + pre.resourceId;
      s.addEventListener('change', function () { render(null); });
      render(pre);
      row._read = function () {
        var v = s.value || '';
        if (v.charAt(0) === 'b') return { kind: 'button', deviceId: Number(v.slice(2)), input: Number(row.querySelector('.f-key').value), event: row.querySelector('.f-press').value };
        if (v.charAt(0) === 'r') return readChannel(row, src.resById[Number(v.slice(2))], false);
        return null;
      };
      row._tasmota = function () { var v = s.value || ''; var d = v.charAt(0) === 'b' ? src.devById[Number(v.slice(2))] : null; return !!(d && d.family === 'tasmota'); };
    }
    row.appendChild(xBtn(row));
    $('#shr-e-when').appendChild(row);
  }
  function tasmotaHint() {
    $('#shr-e-tasmota').hidden = !$$('#shr-e-when .row').some(function (r) { return r._tasmota && r._tasmota(); });
  }

  function addCond(pre) {
    var src = ed.src;
    var row = el('div', { class: 'row' });
    var s = deviceSelect(src, false, [['time', T('chain.c_time')], ['days', T('chain.c_days')]]);
    var fields = el('span', { class: 'chain-fields' });
    row.appendChild(s); row.appendChild(fields);
    var render = function (p) {
      S.clear(fields);
      var v = s.value;
      if (v === 'time') {
        fields.appendChild(el('input', { type: 'time', class: 'form-input f-sm f-from', 'aria-label': T('chain.from'), value: (p && p.from) || '22:00' }));
        fields.appendChild(el('span', { text: '–' }));
        fields.appendChild(el('input', { type: 'time', class: 'form-input f-sm f-to', 'aria-label': T('chain.to'), value: (p && p.to) || '06:00' }));
      } else if (v === 'days') {
        var opts = DAY_PRESETS.map(function (d) { return [d[0], T(d[1])]; });
        for (var i = 1; i <= 7; i++) opts.push([String(i), T('chain.only_day', { day: T('chain.day_' + i) })]);
        var ds = sel('f f-days', T('chain.c_days'), opts);
        var key = p && p.days ? p.days.slice().sort().join(',') : '1,2,3,4,5';
        if (!opts.some(function (o) { return o[0] === key; })) ds.appendChild(opt(key, daysLabel(p.days)));
        ds.value = key;
        fields.appendChild(ds);
      } else if (v && v.charAt(0) === 'r') channelFields(fields, src.resById[Number(v.slice(2))], p, true);
    };
    if (pre && (pre.kind === 'time' || pre.kind === 'days')) s.value = pre.kind;
    else if (pre && pre.resourceId != null) s.value = 'r:' + pre.resourceId;
    else s.value = 'time';
    s.addEventListener('change', function () { render(null); });
    render(pre);
    row._read = function () {
      var v = s.value;
      if (v === 'time') return { kind: 'time', from: row.querySelector('.f-from').value, to: row.querySelector('.f-to').value };
      if (v === 'days') return { kind: 'days', days: row.querySelector('.f-days').value.split(',').map(Number) };
      if (v && v.charAt(0) === 'r') return readChannel(row, src.resById[Number(v.slice(2))], true);
      return null;
    };
    row.appendChild(xBtn(row));
    $('#shr-e-if').appendChild(row);
  }

  var UNIT_S = [[3600, 'chain.unit_h'], [60, 'chain.unit_min'], [1, 'chain.unit_s']];
  function addStep(pre) {
    var src = ed.src;
    var wait = pre && pre.kind === 'wait';
    var li = el('li', { class: 'step' + (wait ? ' is-wait' : '') });
    li.appendChild(el('span', { class: 'step-kind', text: T(wait ? 'chain.k_wait' : 'chain.k_action') }));
    if (wait) {
      var sec = pre.seconds || 60;
      var unit = UNIT_S.filter(function (u) { return sec % u[0] === 0; })[0][0];
      var n = numInput('f-n', T('chain.duration'), sec / unit);
      n.min = 1; n.step = '1';
      var u = sel('f f-unit', T('chain.unit'), UNIT_S.slice().reverse().map(function (x) { return [String(x[0]), T(x[1])]; }));
      u.value = String(unit);
      li.appendChild(n); li.appendChild(u);
      li.appendChild(el('span', { class: 'form-hint f-wait-hint' }));
      li._read = function () { return { kind: 'wait', seconds: Math.round(Number(n.value) * Number(u.value)) }; };
    } else {
      var list = actResources(src);
      var s = el('select', { class: 'form-select dev', 'aria-label': T('chain.device') }, list.map(function (r) { return opt(String(r.id), r.name || ('#' + r.id)); }));
      var fields = el('span', { class: 'chain-fields shr-fields' });
      li.appendChild(s); li.appendChild(fields);
      var setRes = function () { li._res = src.resById[Number(s.value)]; renderActionFields(fields, li._res); };
      if (pre && pre.resourceId != null) s.value = String(pre.resourceId);
      s.addEventListener('change', setRes);
      setRes();
      if (pre && pre.set) {
        var op = fields.querySelector('.shr-f-aop');
        if (op) {
          var st = pre.set; var v = 'on';
          if (st.cover) v = st.cover; else if ('pos' in st) v = 'pos'; else if ('bri' in st) v = 'bri'; else if (st.on === false) v = 'off';
          op.value = v; op.dispatchEvent(new Event('change'));
          if (v === 'pos') { var ps = fields.querySelector('.shr-f-pos'); if (ps) ps.value = st.pos; }
          else if (v === 'bri') { var b = fields.querySelector('.shr-f-bri'); if (b) b.value = st.bri; }
        }
      }
      li._read = function () { var a = li._res ? readAction(li) : null; return a ? { kind: 'action', resourceId: a.resourceId, set: a.set } : null; };
    }
    var move = function (d) {
      return el('button', { type: 'button', class: 'btn row-x', text: d < 0 ? '↑' : '↓', 'aria-label': T(d < 0 ? 'chain.up' : 'chain.down'), on: { click: function () {
        var to = d < 0 ? li.previousElementSibling : li.nextElementSibling;
        if (!to) return;
        if (d < 0) li.parentNode.insertBefore(li, to); else li.parentNode.insertBefore(to, li);
        edChanged();
      } } });
    };
    li.appendChild(el('span', { class: 'step-acts' }, [move(-1), move(1), xBtn(li)]));
    $('#shr-e-steps').appendChild(li);
    waitHints();
  }
  function waitHints() {
    var re = $('#shr-e-re').value;
    $$('#shr-e-steps .f-wait-hint').forEach(function (h) { h.textContent = re === 'restart' ? T('chain.wait_restart') : (re === 'cancel' ? T('chain.wait_cancel') : ''); });
    var full = $$('#shr-e-steps .step').length >= MAX_STEPS;
    $('#shr-e-add-act').disabled = full; $('#shr-e-add-wait').disabled = full;
  }
  function setMode(m) {
    ed.mode = m === 'any' ? 'any' : 'all';
    $$('#shr-edit-modal .seg button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-mode') === ed.mode ? 'true' : 'false'); });
  }
  function readDef() {
    var pick = function (selr) { return $$(selr).map(function (r) { return r._read ? r._read() : null; }).filter(Boolean); };
    return { version: 2, triggers: pick('#shr-e-when > .row'), conditions: { mode: ed.mode, list: pick('#shr-e-if > .row') }, steps: pick('#shr-e-steps > .step'), retrigger: $('#shr-e-re').value };
  }
  function whereText() {
    var g = ed.src.gw;
    $('#shr-e-where-text').textContent = '';
    $('#shr-e-where-text').appendChild(el('b', { text: T('chain.where_title', { name: ed.src.name }) }));
    $('#shr-e-where-text').appendChild(document.createTextNode(' ' + T('chain.where') + (g.state !== 'running' ? ' ' + T('rules.edge_away') : '')));
  }
  function fillGateways() {
    var s = S.clear($('#shr-e-gw'));
    s.appendChild(el('optgroup', { label: T('chain.group_gc') }, edgeGws.map(function (g) { return opt('e:' + g.id, g.name); })));
    if (deconzGws.length && !ed.rule) s.appendChild(el('optgroup', { label: T('source.group_deconz') }, deconzGws.map(function (g) { return opt('d:' + g.id, g.name); })));
    s.value = ed.src.key;
    s.disabled = !!ed.rule; // a chain stays on its gateway
  }
  function openEditor(src, rule) {
    var go = function () {
      ed.src = src; ed.rule = rule || null; ed.loop = null;
      $('#shr-e-title').textContent = T(rule ? 'chain.edit_title' : 'chain.new_title');
      $('#shr-e-name').value = rule ? (rule.name || '') : '';
      fillGateways();
      whereText();
      fillRows(rule ? rule.v2 : null);
      S.openModal('shr-edit-modal', '#shr-e-name');
      edChanged();
    };
    if (src.rules) go(); else loadSource(src).then(go);
  }
  function fillRows(def) {
    S.clear($('#shr-e-when')); S.clear($('#shr-e-if')); S.clear($('#shr-e-steps'));
    $('#shr-e-check').hidden = true; $('#shr-e-test').hidden = true;
    $('#shr-e-re').value = (def && def.retrigger) || 'restart';
    setMode(def && def.conditions && def.conditions.mode);
    if (def) {
      (def.triggers || []).forEach(addWhen);
      ((def.conditions && def.conditions.list) || []).forEach(addCond);
      (def.steps || []).forEach(addStep);
    } else { addWhen(null); addStep({ kind: 'action' }); }
    tasmotaHint(); waitHints();
  }
  /** Something changed: the hints, then (a moment later) the check of the server. */
  function edChanged() {
    waitHints(); tasmotaHint();
    clearTimeout(ed.timer);
    ed.timer = setTimeout(checkNow, 500);
  }
  function quote(list) { return (list || []).map(function (n) { return T('chain.quote', { n: n }); }).join(', '); }
  function renderCheck(res) {
    var box = $('#shr-e-check'); var txt = $('#shr-e-check-text');
    ed.loop = res ? res.loop : null;
    if (!res || (!res.loop && !(res.shared || []).length)) { box.hidden = true; return; }
    var parts = [];
    if (res.loop === 'sure') parts.push(T('chain.loop_sure', { chains: quote(res.chains) }));
    else if (res.loop === 'possible') parts.push(T('chain.loop_possible', { chains: quote(res.chains) }));
    (res.shared || []).forEach(function (s) { parts.push(T('chain.shared', { device: s.device, chains: quote(s.chains) })); });
    if (!res.loop) parts.push(T('chain.no_loop'));
    txt.textContent = T('chain.check') + ' ' + parts.join(' ');
    box.className = 'check-line' + (res.loop === 'sure' ? ' is-crit' : (res.loop ? '' : ' is-info'));
    box.hidden = false;
  }
  function checkNow() {
    if (!ed.src || $('#shr-edit-modal').hidden) return;
    var seq = ++ed.seq;
    S.api('POST', 'rules/check', { gateway_id: ed.src.id, id: ed.rule ? ed.rule.id : null, definition: readDef() }).then(function (res) {
      if (seq === ed.seq) renderCheck(res);
    }, function () { if (seq === ed.seq) renderCheck(null); }); // not complete yet: nothing to say
  }
  function saveChain() {
    var name = $('#shr-e-name').value.trim();
    if (!name) { fail(T('rules.name_required')); $('#shr-e-name').focus(); return; }
    var def = readDef();
    if (!def.triggers.length) { fail(T('chain.need_trigger')); return; }
    if (!def.steps.some(function (s) { return s.kind === 'action'; })) { fail(T('chain.need_action')); return; }
    var btn = $('#shr-e-save'); btn.disabled = true;
    var p = ed.rule ? S.api('PUT', 'rules/' + ed.rule.id, { name: name, definition: def })
      : S.api('POST', 'rules', { gateway_id: ed.src.id, source: 'edge', name: name, definition: def });
    p.then(function () { S.closeModal('shr-edit-modal'); return reload(); }, function (e) {
      var d = (e && e.data) || {};
      if (d.code === 'SMARTHOME_RULE_LOOP') { renderCheck({ loop: 'sure', chains: d.chains || [], shared: [] }); return; }
      if (e && e.status === 409) { S.closeModal('shr-edit-modal'); showLimit(e.message); return; }
      fail(e);
    }).then(function () { btn.disabled = false; });
  }

  // ── Testlauf ──
  function fmtValue(c, v) {
    if (v == null) return '?';
    if (c && c.kind === 'days') return T('chain.day_' + v);
    if (typeof v === 'boolean') return T(v ? 'rules.act_on' : 'rules.act_off');
    if (typeof v === 'number') return num(v) + (c && UNITS[c.kind] ? ' ' + UNITS[c.kind] : (c && c.kind === 'cover' ? ' %' : ''));
    return String(v);
  }
  /** The conditions the test looked at: version 2 its NUR WENN; version 1 its triggers and the time window. */
  function testConds(t, rule, def) {
    if (t.v === 1 && rule) {
      var d = rule.definition || {};
      var list = (d.triggers || []).map(function (x) { return x.kind === 'state' || x.kind === 'cover' ? { kind: x.kind, resourceId: x.resourceId, is: x.event } : x; });
      if (d.timeWindow && d.timeWindow.from) list.push({ kind: 'time', from: d.timeWindow.from, to: d.timeWindow.to });
      return list;
    }
    return (def.conditions && def.conditions.list) || [];
  }
  function renderTest(ids, t, def, src, rule) {
    var conds = testConds(t, rule, def);
    var at = new Date(t.at);
    var stamp = isFinite(at) ? at.toLocaleTimeString(S.CTX.lang === 'en' ? 'en-GB' : 'de-DE') : '';
    $(ids.sub).textContent = T('chain.test_sub', { trigger: whenLabel((def.triggers || [])[0], src) || '–', gw: src.name, time: stamp });
    var host = S.clear($(ids.eval));
    (t.checks || []).forEach(function (c, i) {
      var mark = c.ok === true ? ['ok', '✓'] : (c.ok === false ? ['no', '✗'] : ['unk', '?']);
      host.appendChild(el('li', {}, [el('span', { class: mark[0], text: mark[1], 'aria-hidden': 'true' }), el('span', { class: 'sr-only', text: T('chain.check_' + mark[0]) }),
        el('span', { text: conds[i] ? condLabel(conds[i], src) : '' }), el('span', { class: 'v', text: fmtValue(conds[i], c.v) })]));
    });
    var first = (t.checks || []).findIndex(function (c) { return c.ok !== true; });
    var what = first >= 0 && conds[first] ? condLabel(conds[first], src) : '';
    var res = $(ids.result);
    var txt;
    if (t.result === 'run') txt = T((t.checks || []).length ? 'chain.would_run' : 'chain.would_run_nocond');
    else if (t.result === 'skip') txt = T('chain.would_skip', { what: what });
    else txt = T('chain.would_unknown', { what: what });
    if (t.stopped) txt += ' ' + T('chain.test_stopped');
    else if (t.running) txt += ' ' + T('chain.test_running');
    res.textContent = txt;
    res.className = 'result' + (t.result === 'run' && !t.stopped ? ' is-good' : '');
  }
  function testDraft() {
    if (!ed.src) return;
    var def = readDef();
    var box = $('#shr-e-test');
    S.api('POST', 'rules/test', { gateway_id: ed.src.id, definition: def }).then(function (r) {
      renderTest({ sub: '#shr-e-test-sub', eval: '#shr-e-test-eval', result: '#shr-e-test-result' }, r.test, def, ed.src, null);
      box.hidden = false;
    }, function (e) {
      S.clear($('#shr-e-test-eval')); $('#shr-e-test-sub').textContent = '';
      var res = $('#shr-e-test-result'); res.className = 'result'; res.textContent = (e && e.message) || T('common.error');
      box.hidden = false;
    });
  }

  // ── Protokoll ──
  var log = { rule: null, runs: [], sel: null, testing: null };
  function setView(v) {
    view = v;
    $('#shr-list-view').hidden = v !== 'list';
    $('#shr-log-view').hidden = v !== 'log';
    $('#shr-log-open').hidden = v === 'log';
    $('#shr-new').hidden = v === 'log';
  }
  function openLog(ruleId, testRule) {
    setView('log');
    log.rule = ruleId || null;
    log.testing = testRule || null;
    $('#shr-test-card').hidden = !testRule;
    $('#shr-split').classList.toggle('is-single', !testRule);
    reload().then(function () { if (testRule) runTest(); });
  }
  function edgeRules() {
    var out = [];
    srcList().forEach(function (k) { if (k.charAt(0) === 'e') (sources[k].rules || []).forEach(function (r) { out.push({ rule: r, src: sources[k] }); }); });
    return out;
  }
  function renderLog() {
    sourceHint();
    var cs = S.clear($('#shr-log-chain'));
    cs.appendChild(opt('', T('chain.filter_all_chains')));
    edgeRules().forEach(function (x) { cs.appendChild(opt(String(x.rule.id), x.rule.name)); });
    cs.value = log.rule ? String(log.rule) : '';
    var src = sources[current];
    var q = [];
    if (src && src.type === 'e') q.push('gateway_id=' + src.id);
    if (log.rule) q.push('rule_id=' + log.rule);
    if ($('#shr-log-result').value === '1') q.push('problems=1');
    return S.api('GET', 'rules/runs' + (q.length ? '?' + q.join('&') : '')).then(function (r) {
      log.runs = r.runs || [];
      if (!log.runs.some(function (x) { return x.uid === log.sel; })) log.sel = log.runs.length ? log.runs[0].uid : null;
      renderRuns();
    }, function (e) { log.runs = []; renderRuns(); fail(e); });
  }
  function timeOf(iso) {
    var d = new Date(iso);
    if (!isFinite(d)) return '';
    var t = d.toLocaleTimeString(S.CTX.lang === 'en' ? 'en-GB' : 'de-DE');
    return new Date().toDateString() === d.toDateString() ? t : d.toLocaleDateString(S.CTX.lang === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit' }) + ' ' + t;
  }
  function runTrigger(run, x) {
    if (run.by === 'manual') return T('chain.by_manual');
    var trig = x && x.rule.v2 ? (x.rule.v2.triggers || []) : [];
    return whenLabel(trig[run.trigger == null ? 0 : run.trigger], x && x.src);
  }
  function stepOf(x, idx) { return x && x.rule.v2 && x.rule.definition && x.rule.definition.version === 2 ? (x.rule.v2.steps || [])[idx] : null; }
  function resultPill(run, x) {
    var why = run.reason || '';
    var cls = ''; var txt;
    if (run.result === 'ok') { cls = 'is-good'; txt = T('chain.res_ok') + (run.late ? ' · ' + T('chain.late') : ''); }
    else if (run.result === 'skip') {
      var m = /^cond:(\d+)$/.exec(why);
      var c = m && x && x.rule.v2 && x.rule.v2.conditions ? x.rule.v2.conditions.list[Number(m[1])] : null;
      txt = c ? T('chain.res_skip_cond', { what: condLabel(c, x.src) }) : T('chain.res_skip');
    } else if (run.result === 'partial') {
      cls = 'is-warn';
      var na = (run.ev || []).filter(function (e) { return e[1] === 'noack'; })[0];
      var s = na ? stepOf(x, na[2]) : null;
      txt = T('chain.res_partial') + ' · ' + (why === 'noack' && s ? T('chain.why_noack', { n: nameIn(x.src, s.resourceId) }) : T('chain.why_' + (['limit', 'fail', 'noack'].indexOf(why) >= 0 ? why : 'fail')));
    } else if (run.result === 'cancel') txt = T('chain.res_cancel') + (why === 'cond' ? ' · ' + T('chain.why_cond') : (why === 'restart' ? ' · ' + T('chain.why_restart') : ''));
    else if (run.result === 'stopped') { cls = 'is-crit'; txt = T('chain.res_stopped', { n: stoppedCount(why) }); }
    else if (run.result === 'running') { cls = 'is-info'; txt = T('chain.res_running'); }
    else { cls = 'is-crit'; txt = T('chain.res_error'); }
    return el('span', { class: 'sh-pill ' + cls, text: txt });
  }
  function renderRuns() {
    var body = S.clear($('#shr-log-rows'));
    var byId = {};
    edgeRules().forEach(function (x) { byId[x.rule.id] = x; });
    if (!log.runs.length) body.appendChild(el('tr', {}, [el('td', { colspan: '4', class: 'sh-sub', text: T('chain.log_empty') })]));
    log.runs.forEach(function (run) {
      var x = byId[run.rule_id];
      var tr = el('tr', { class: run.uid === log.sel ? 'sel' : '', tabindex: '0', 'aria-selected': run.uid === log.sel ? 'true' : 'false' }, [
        el('td', { class: 't', text: timeOf(run.at) }), el('td', { text: x ? x.rule.name : T('chain.missing') }), el('td', { text: runTrigger(run, x) }), el('td', {}, [resultPill(run, x)]),
      ]);
      var pick = function () { log.sel = run.uid; renderRuns(); };
      tr.addEventListener('click', pick);
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      body.appendChild(tr);
    });
    renderTimeline(log.runs.filter(function (r) { return r.uid === log.sel; })[0], byId);
  }
  function msLabel(ms) {
    if (ms < 1000) return '+' + ms + ' ms';
    if (ms < 60000) return '+' + Math.round(ms / 1000) + ' s';
    if (ms < 3600000) return '+' + Math.round(ms / 60000) + ' min';
    return '+' + Math.round(ms / 3600000) + ' h';
  }
  function renderTimeline(run, byId) {
    var host = S.clear($('#shr-log-timeline'));
    if (!run) return;
    host.setAttribute('aria-label', T('chain.timeline', { time: timeOf(run.at) }));
    var x = byId[run.rule_id];
    var v2 = x && x.rule.definition && x.rule.definition.version === 2;
    (run.ev || []).forEach(function (e) {
      var code = e[1]; var a = e[2]; var txt; var w = false;
      var s = v2 ? stepOf(x, a) : null;
      var label = s ? stepLabel(s, x.src) : '';
      if (code === 'trig') txt = runTrigger({ by: 'event', trigger: a }, x);
      else if (code === 'manual') txt = T('chain.by_manual');
      else if (code === 'cond') {
        var c = typeof a === 'number' && x && x.rule.v2 && x.rule.v2.conditions ? x.rule.v2.conditions.list[a] : null;
        txt = a === 'ok' ? T('chain.tl_cond_ok') : (c ? T('chain.tl_cond_no', { what: condLabel(c, x.src) }) : T('chain.tl_cond_unknown'));
      } else if (code === 'act') txt = v2 ? label : T('chain.tl_sent');
      else if (code === 'ack') txt = T('chain.tl_ack', { what: label });
      else if (code === 'noack') txt = T('chain.tl_noack', { what: label });
      else if (code === 'fail') txt = T('chain.tl_fail', { what: label || String(a || '') });
      else if (code === 'limit') txt = T('chain.tl_limit', { what: label });
      else if (code === 'wait') { txt = T('chain.tl_wait', { what: label }); w = true; }
      else if (code === 'waited') { txt = T('chain.tl_waited'); w = true; }
      else if (code === 'restart') txt = T('chain.tl_restart');
      else if (code === 'cancel') txt = T('chain.tl_cancel');
      else if (code === 'stop') txt = T('chain.tl_stop', { n: a });
      else txt = code;
      host.appendChild(el('li', { class: w ? 'w' : '' }, [el('span', { class: 'ms', text: msLabel(e[0]) }), txt]));
    });
    if (run.late) host.appendChild(el('li', { class: 'w' }, [el('span', { class: 'ms', text: '' }), T('chain.tl_late')]));
  }
  function runTest() {
    var r = log.testing;
    if (!r) return;
    var x = findRule(r.id);
    if (!x) return;
    $('#shr-test-title').textContent = T('chain.test_title', { name: x.rule.name });
    var ids = { sub: '#shr-test-sub', eval: '#shr-test-eval', result: '#shr-test-result' };
    S.api('POST', 'rules/test', { gateway_id: x.src.id, id: x.rule.id }).then(function (res) {
      renderTest(ids, res.test, x.rule.v2 || {}, x.src, x.rule);
    }, function (e) {
      S.clear($(ids.eval)); $(ids.sub).textContent = '';
      var res = $(ids.result); res.className = 'result'; res.textContent = (e && e.message) || T('common.error');
    });
  }
  function runAnyway() {
    var x = log.testing && findRule(log.testing.id);
    if (!x) return;
    S.confirm(T('chain.run_confirm', { name: x.rule.name }), T('chain.run_anyway')).then(function (ok) {
      if (!ok) return;
      S.api('POST', 'rules/test', { gateway_id: x.src.id, id: x.rule.id, run: true }).then(function () {
        S.toast(T('chain.run_started'), 'good');
        setTimeout(function () { renderLog(); }, 2500);
      }, fail);
    });
  }

  // ── Wiring ──
  $('#shr-new').addEventListener('click', function () {
    var src = sources[current];
    if (!src) {
      var e = edgeGws.filter(function (g) { return g.state === 'running'; })[0] || edgeGws[0];
      src = e ? sources['e:' + e.id] : (deconzGws[0] ? sources['d:' + deconzGws[0].id] : null);
    }
    if (!src) return;
    if (src.type === 'e') openEditor(src, null);
    else (src.rules ? Promise.resolve() : loadSource(src)).then(function () { openBuilderFor(src, null); });
  });
  $('#shr-save').addEventListener('click', saveRule);
  $('#shr-add-when').addEventListener('click', function () { addTriggerRow(); });
  $('#shr-add-then').addEventListener('click', function () { addActionRow(); });
  $('#shr-gateway-count').addEventListener('click', loadCount);
  $('#shr-gateway').addEventListener('change', function () { current = $('#shr-gateway').value; reload(); });
  $('#shr-log-open').addEventListener('click', function () { openLog(null, null); });
  $('#shr-log-back').addEventListener('click', function () { setView('list'); reload(); });
  $('#shr-log-chain').addEventListener('change', function () { log.rule = Number($('#shr-log-chain').value) || null; renderLog(); });
  $('#shr-log-result').addEventListener('change', function () { renderLog(); });
  $('#shr-test-again').addEventListener('click', runTest);
  $('#shr-test-run').addEventListener('click', runAnyway);

  $('#shr-e-add-dev').addEventListener('click', function () { addWhen(null); edChanged(); });
  $('#shr-e-add-time').addEventListener('click', function () { addWhen({ kind: 'time', at: '07:00' }); edChanged(); });
  $('#shr-e-add-cond').addEventListener('click', function () { addCond(null); edChanged(); });
  $('#shr-e-add-act').addEventListener('click', function () { addStep({ kind: 'action' }); edChanged(); });
  $('#shr-e-add-wait').addEventListener('click', function () { addStep({ kind: 'wait', seconds: 180 }); edChanged(); });
  $$('#shr-edit-modal .seg button').forEach(function (b) { b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); edChanged(); }); });
  $('#shr-e-re').addEventListener('change', edChanged);
  $('#shr-edit-modal .chain-body').addEventListener('input', edChanged);
  $('#shr-edit-modal .chain-body').addEventListener('change', function (e) { if (e.target && e.target.id !== 'shr-e-gw') edChanged(); });
  $('#shr-e-gw').addEventListener('change', function () {
    var v = $('#shr-e-gw').value; var src = sources[v]; var name = $('#shr-e-name').value.trim();
    if (!src) return;
    if (src.type === 'd') {
      // a deCONZ gateway runs its own rules: its builder, as before
      S.closeModal('shr-edit-modal');
      (src.rules ? Promise.resolve() : loadSource(src)).then(function () { openBuilderFor(src, null, name); });
      return;
    }
    (src.rules ? Promise.resolve() : loadSource(src)).then(function () {
      ed.src = src; whereText(); fillRows(null); $('#shr-e-name').value = name; edChanged();
    });
  });
  $('#shr-e-save').addEventListener('click', saveChain);
  $('#shr-e-test-btn').addEventListener('click', testDraft);

  loadGateways().then(reload, function () { emptyMsg(S.clear($('#shr-list')), T('load_error')); });
}());
