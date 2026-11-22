'use strict';

// MQTT messages of Shelly (Gen1, Gen2/3/4) and Tasmota devices → one normalised state per device.
// Pure functions, no I/O (tested with real sample messages in test/edge_normalize.test.js).
//
//   parse(topic, payload) → null (not a state message: our own commands, unknown topics, broken JSON)
//                           | { base, family, patch, events? }
//                           events: button presses (since 1.11.0, for the logic chains — an event, not a state):
//                           [{ input: 0…7, ev: 'single' | 'double' | 'triple' | 'long', cnt? }]
//                           Shelly Gen1 input_event/<n> { event: S | SS | SSS | L, event_cnt }, Gen2+ events/rpc
//                           NotifyEvent (single_push, double_push, triple_push, long_push), Tasmota with SetOption73 1
//                           stat/RESULT { ButtonN: { Action: SINGLE | DOUBLE | TRIPLE | HOLD } }
//   apply(device, patch)  → merges a patch into a device record (create one with newDevice(base, family))
//   snapshot(device)      → what the server part gets: { base, family, online, ch, sensor, info, drop }
//
// Topic roots (base): Shelly "shellies/<name>" (Gen2+: MQTT topic prefix, Gen1: the custom MQTT id),
// Tasmota "tasmota/<topic>" (FullTopic tasmota/%topic%/%prefix%/).
//
// Channels are keyed alike for every family: "switch:<n>", "light:<n>", "cover:<n>" (n from 0):
//   switch  { on, power (W), energy (Wh, lifetime counter) | today (kWh, Tasmota) }
//   light   { on, bri (0–100), power, energy | today }
//   cover   { pos (0–100 % open, null = not calibrated), moving ('opening' | 'closing' | null), power }
//   thermostat (since 1.17.0) { temp (°C measured), target (°C), valve (0–100 %), kind: 'gen1' | 'blu', schedule (its
//           own plan is on, Gen1), boost (minutes left, Gen1), window (the device saw an open window, Gen1), bat (%),
//           paired (BLU), rid (BLU: the component id 200…) }
//           Shelly TRV (Gen1): shellies/<id>/info { thermostats: [{ tmp, target_t, pos, schedule, boost_minutes,
//           window_open }], bat } → thermostat:<n>. Shelly BLU TRV through a BLU Gateway Gen3 (a Gen3 device, family
//           shelly2): its components blutrv:200… (status/blutrv:<id>, NotifyStatus / NotifyFullStatus) { current_C,
//           target_C, pos, battery, paired } → thermostat:<id − 200>.
// sensor { temperature (°C), humidity (%), battery (%), external (on USB power, Gen2+) }, online true | false | null
// (LWT / "online").
//
// Since 1.12.0 also zigbee2mqtt on the gateway, for the logic chains only (the server part gets these devices from
// GateControl, gc.radio.zigbee): parseZ2m(base, payload, { kind, chs }) → { patch, events? } for a device's state
// message zigbee2mqtt/<friendly name> (edge/index.js maps the name to base zigbee2mqtt/0x<IEEE address>). kind light →
// light:0 { on, bri }, plug → switch:0 (with chs ['l1', 'l2', …] switch:<i> per channel state_<chs[i]>), cover →
// cover:0 { pos, moving }; power on the first channel; sensor { temperature, humidity, battery, open (contact false),
// presence (occupancy / presence), water (water_leak) }; `action` single / double / triple / hold (also 1_single,
// button_2_double …) → events like a button.

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const COMP_RE = /^(switch|light|cover|temperature|humidity|devicepower):(\d{1,2})$/;
const BLUTRV_RE = /^blutrv:(2\d\d)$/;

function num(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) ? n : null;
}
function round(v, digits) {
  const n = num(v);
  if (n == null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
function pct(v) {
  const n = num(v);
  return n == null ? null : Math.max(0, Math.min(100, Math.round(n)));
}
function text(buf) {
  return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf == null ? '' : buf);
}
function json(buf) {
  try {
    const v = JSON.parse(text(buf));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}
function onOff(s) {
  const v = String(s).trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  return null;
}
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// ─── Button presses (events for the logic chains) ───

const GEN1_EVENTS = { S: 'single', SS: 'double', SSS: 'triple', L: 'long' };
const GEN2_EVENTS = { single_push: 'single', double_push: 'double', triple_push: 'triple', long_push: 'long' };
const TASMOTA_EVENTS = { SINGLE: 'single', DOUBLE: 'double', TRIPLE: 'triple', HOLD: 'long' };
const INPUT_RE = /^input:(\d)$/;

/** Gen2+ NotifyEvent → [{ input, ev }] (other events of the device — btn_down, ota, … — are not presses). */
function gen2Events(params) {
  const out = [];
  for (const e of (isObj(params) && Array.isArray(params.events) ? params.events : []).slice(0, 16)) {
    if (!isObj(e)) continue;
    const m = INPUT_RE.exec(String(e.component || ''));
    const ev = GEN2_EVENTS[e.event];
    if (m && ev && Number(m[1]) <= 7) out.push({ input: Number(m[1]), ev });
  }
  return out;
}

/** Tasmota (SetOption73 1): { Button1: { Action: 'SINGLE' } } → [{ input: 0, ev: 'single' }]. */
function tasmotaEvents(o) {
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    const m = /^Button([1-8])$/.exec(k);
    const ev = m && isObj(v) ? TASMOTA_EVENTS[String(v.Action || '').toUpperCase()] : null;
    if (ev) out.push({ input: Number(m[1]) - 1, ev });
  }
  return out;
}

// ─── Shelly Gen2+ (status/<component>, events/rpc NotifyStatus / NotifyFullStatus) ───

/** A BLU TRV of a BLU Gateway Gen3 (component blutrv:200…) → thermostat:<id − 200>. */
function bluTrv(patch, id, o) {
  const c = { kind: 'blu', rid: id };
  if (o.current_C != null && num(o.current_C) != null) c.temp = round(o.current_C, 1);
  if (o.target_C != null && num(o.target_C) != null) c.target = round(o.target_C, 1);
  if (o.pos != null && num(o.pos) != null) c.valve = pct(o.pos);
  if (o.battery != null && num(o.battery) != null) c.bat = pct(o.battery);
  if (typeof o.paired === 'boolean') c.paired = o.paired;
  (patch.ch = patch.ch || {})[`thermostat:${id - 200}`] = c;
}

/** Shelly TRV (Gen1): the thermostats of its status (shellies/<id>/info) → thermostat:<n>, the battery. */
function gen1Trv(o) {
  const patch = { ch: {} };
  o.thermostats.slice(0, 2).forEach((t, i) => {
    if (!isObj(t)) return;
    const c = { kind: 'gen1' };
    if (isObj(t.tmp) && t.tmp.is_valid !== false && num(t.tmp.value) != null) c.temp = round(t.tmp.value, 1);
    if (isObj(t.target_t) && num(t.target_t.value) != null) c.target = round(t.target_t.value, 1);
    if (t.pos != null && num(t.pos) != null) c.valve = pct(t.pos);
    if (typeof t.schedule === 'boolean') c.schedule = t.schedule;
    if (t.boost_minutes != null && num(t.boost_minutes) != null) c.boost = Math.max(0, Math.round(num(t.boost_minutes)));
    if (typeof t.window_open === 'boolean') c.window = t.window_open;
    if (isObj(o.bat) && num(o.bat.value) != null) c.bat = pct(o.bat.value);
    patch.ch[`thermostat:${i}`] = c;
  });
  if (!Object.keys(patch.ch).length) return null;
  if (isObj(o.bat) && num(o.bat.value) != null) patch.sensor = { battery: pct(o.bat.value) };
  if (isObj(o.fw_info) && typeof o.fw_info.fw === 'string') patch.info = { firmware: o.fw_info.fw.slice(0, 60) };
  return patch;
}

/** One Gen2 component (switch:0, cover:0, …) into the patch; unknown components are ignored. */
function gen2Component(patch, key, o) {
  const b = BLUTRV_RE.exec(key);
  if (b && isObj(o)) { bluTrv(patch, Number(b[1]), o); return; }
  const m = COMP_RE.exec(key);
  if (!m || !isObj(o)) return;
  const [, type, idx] = m;
  if (type === 'switch' || type === 'light') {
    const c = {};
    if (typeof o.output === 'boolean') c.on = o.output;
    if (type === 'light' && o.brightness != null) c.bri = pct(o.brightness);
    if (o.apower != null) c.power = round(o.apower, 1);
    if (isObj(o.aenergy) && o.aenergy.total != null) c.energy = round(o.aenergy.total, 3);
    if (Object.keys(c).length) (patch.ch = patch.ch || {})[`${type}:${idx}`] = c;
    return;
  }
  if (type === 'cover') {
    const c = {};
    if ('current_pos' in o) c.pos = o.current_pos == null ? null : pct(o.current_pos);
    if (typeof o.state === 'string') c.moving = o.state === 'opening' ? 'opening' : o.state === 'closing' ? 'closing' : null;
    if (o.apower != null) c.power = round(o.apower, 1);
    if (Object.keys(c).length) (patch.ch = patch.ch || {})[`cover:${idx}`] = c;
    return;
  }
  if (idx !== '0') return; // sensors: the first one only
  const s = {};
  if (type === 'temperature' && o.tC != null) s.temperature = round(o.tC, 1);
  if (type === 'humidity' && o.rh != null) s.humidity = round(o.rh, 0);
  if (type === 'devicepower' && isObj(o.battery) && o.battery.percent != null) s.battery = pct(o.battery.percent);
  // on USB power the device stays awake (the page then shows no "schläft")
  if (type === 'devicepower' && isObj(o.external) && typeof o.external.present === 'boolean') s.external = o.external.present;
  if (Object.keys(s).length) patch.sensor = { ...(patch.sensor || {}), ...s };
}

function parseShelly(base, rest, payload) {
  const patch = {};
  const p = rest.join('/');
  if (p === 'online') {
    const v = onOff(text(payload));
    if (v == null) return null;
    return { family: null, patch: { online: v } };
  }
  // Gen2+: status/<component>, events/rpc
  if (rest[0] === 'status' && rest.length === 2) {
    const o = json(payload);
    if (!o) return null;
    gen2Component(patch, rest[1], o);
    return Object.keys(patch).length ? { family: 'shelly2', patch } : null;
  }
  if (p === 'events/rpc') {
    const o = json(payload);
    if (o && o.method === 'NotifyEvent') {
      const events = gen2Events(o.params);
      return events.length ? { family: 'shelly2', patch: {}, events } : null;
    }
    if (!o || (o.method !== 'NotifyStatus' && o.method !== 'NotifyFullStatus') || !isObj(o.params)) return null;
    for (const [k, v] of Object.entries(o.params)) gen2Component(patch, k, v);
    if (typeof o.src === 'string' && NAME_RE.test(o.src)) patch.info = { id: o.src };
    return Object.keys(patch).length ? { family: 'shelly2', patch } : null;
  }
  // Gen1: relay/<n>[/power|/energy], roller/<n>[/pos|/power|/energy], light/<n>[/status|/power|/energy], sensor/<x>, announce
  const t = text(payload).trim();
  if (rest[0] === 'input_event' && rest.length === 2 && /^[0-7]$/.test(rest[1])) {
    const o = json(payload);
    const ev = o && GEN1_EVENTS[o.event];
    if (!ev) return null;
    const cnt = Number.isSafeInteger(o.event_cnt) ? o.event_cnt : null;
    return { family: 'shelly1', patch: {}, events: [{ input: Number(rest[1]), ev, ...(cnt == null ? {} : { cnt }) }] };
  }
  const kindOf = { relay: 'switch', roller: 'cover', light: 'light' }[rest[0]];
  if (kindOf && /^\d{1,2}$/.test(rest[1] || '')) {
    const key = `${kindOf}:${rest[1]}`;
    const field = rest.slice(2).join('/');
    const c = {};
    if (field === '') {
      if (kindOf === 'cover') {
        const v = t.toLowerCase();
        if (v === 'open') c.moving = 'opening';
        else if (v === 'close') c.moving = 'closing';
        else if (v === 'stop') c.moving = null;
        else return null;
      } else {
        const v = t.toLowerCase() === 'overpower' ? false : onOff(t);
        if (v == null) return null;
        c.on = v;
      }
    } else if (field === 'power') c.power = round(t, 1);
    else if (field === 'energy') { const wm = num(t); c.energy = wm == null ? null : round(wm / 60, 3); } // watt-minutes → Wh
    else if (field === 'pos' && kindOf === 'cover') { const v = num(t); c.pos = v == null || v < 0 ? null : pct(v); }
    else if (field === 'status' && kindOf === 'light') {
      const o = json(payload);
      if (!o) return null;
      if (typeof o.ison === 'boolean') c.on = o.ison;
      if (o.brightness != null) c.bri = pct(o.brightness);
    } else return null;
    if (Object.values(c).every((v) => v === null) && !('moving' in c) && !('pos' in c)) return null;
    return { family: 'shelly1', patch: { ch: { [key]: c } } };
  }
  if (rest[0] === 'sensor' && rest.length === 2) {
    const v = num(t);
    if (v == null) return null;
    const field = { temperature: 'temperature', humidity: 'humidity', battery: 'battery' }[rest[1]];
    if (!field) return null;
    return { family: 'shelly1', patch: { sensor: { [field]: field === 'temperature' ? round(v, 1) : pct(v) } } };
  }
  // Shelly TRV: its whole status (other Gen1 devices send no thermostats there: not a state of ours)
  if ((p === 'info' || p === 'status') && rest.length === 1) {
    const o = json(payload);
    if (!o || !Array.isArray(o.thermostats)) return null;
    const patch = gen1Trv(o);
    return patch ? { family: 'shelly1', patch } : null;
  }
  if (p === 'announce') {
    const o = json(payload);
    if (!o) return null;
    const info = {};
    if (typeof o.model === 'string') info.model = o.model.slice(0, 40);
    if (typeof o.fw_ver === 'string') info.firmware = o.fw_ver.slice(0, 60);
    if (typeof o.ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(o.ip)) info.ip = o.ip;
    if (typeof o.mac === 'string') info.mac = o.mac.slice(0, 20);
    return Object.keys(info).length ? { family: 'shelly1', patch: { info } } : null;
  }
  return null; // our own rpc/command topics, input (state) topics, info, …
}

// ─── Tasmota (tele/LWT, tele/STATE, tele/SENSOR, stat/RESULT, stat/POWERn, stat/STATUS10/11) ───

/** POWER / POWER1…8, Dimmer of a STATE-like object → tasmota patch fields. */
function tasmotaState(tp, o) {
  for (const [k, v] of Object.entries(o)) {
    const m = /^POWER(\d?)$/.exec(k);
    if (m) {
      const on = onOff(v);
      if (on != null) (tp.power = tp.power || {})[m[1] ? Number(m[1]) : 1] = on;
    }
  }
  if (o.Dimmer != null && pct(o.Dimmer) != null) tp.dimmer = pct(o.Dimmer);
}

/** ENERGY, temperature/humidity sensors, ShutterN of a SENSOR-like object → tasmota patch fields. */
function tasmotaSensor(tp, sensor, o) {
  if (isObj(o.ENERGY)) {
    const e = o.ENERGY;
    const many = (v, digits) => (Array.isArray(v) ? v.map((x) => round(x, digits)) : round(v, digits));
    tp.energy = { power: e.Power != null ? many(e.Power, 1) : null, today: e.Today != null ? many(e.Today, 3) : null };
  }
  for (const [k, v] of Object.entries(o)) {
    const sh = /^Shutter([1-4])$/.exec(k);
    if (sh && isObj(v)) {
      const dir = num(v.Direction);
      (tp.shutters = tp.shutters || {})[Number(sh[1])] = { pos: v.Position == null ? null : pct(v.Position), moving: dir > 0 ? 'opening' : dir < 0 ? 'closing' : null };
      continue;
    }
    if (!isObj(v) || k === 'ENERGY') continue;
    if (v.Temperature != null && sensor.temperature == null) sensor.temperature = round(v.Temperature, 1);
    if (v.Humidity != null && sensor.humidity == null) sensor.humidity = round(v.Humidity, 0);
  }
}

function parseTasmota(base, rest, payload) {
  if (rest.length !== 2) return null;
  const [prefix, cmd] = rest;
  if (prefix === 'cmnd') return null; // our own commands
  if (prefix === 'tele' && cmd === 'LWT') {
    const v = text(payload).trim().toLowerCase();
    if (v !== 'online' && v !== 'offline') return null;
    return { family: 'tasmota', patch: { online: v === 'online' } };
  }
  const tp = {};
  const sensor = {};
  const info = {};
  const events = [];
  if (prefix === 'stat' && /^POWER\d?$/.test(cmd)) {
    const on = onOff(text(payload));
    if (on == null) return null;
    tasmotaState(tp, { [cmd]: on ? 'ON' : 'OFF' });
  } else if (prefix === 'stat' && /^SHUTTER[1-4]$/.test(cmd)) {
    const v = num(text(payload));
    if (v == null) return null;
    tp.shutters = { [Number(cmd.slice(7))]: { pos: pct(v) } };
  } else {
    const o = json(payload);
    if (!o) return null;
    if (prefix === 'tele' && cmd === 'STATE') tasmotaState(tp, o);
    else if (prefix === 'tele' && cmd === 'SENSOR') tasmotaSensor(tp, sensor, o);
    else if (prefix === 'stat' && cmd === 'RESULT') { tasmotaState(tp, o); tasmotaSensor(tp, sensor, o); events.push(...tasmotaEvents(o)); }
    else if (prefix === 'stat' && cmd === 'STATUS11' && isObj(o.StatusSTS)) tasmotaState(tp, o.StatusSTS);
    else if (prefix === 'stat' && cmd === 'STATUS10' && isObj(o.StatusSNS)) tasmotaSensor(tp, sensor, o.StatusSNS);
    else if (prefix === 'tele' && /^INFO[12]$/.test(cmd)) {
      const i = isObj(o.Info1) ? o.Info1 : isObj(o.Info2) ? o.Info2 : o;
      if (typeof i.Module === 'string') info.model = i.Module.slice(0, 40);
      if (typeof i.Version === 'string') info.firmware = i.Version.slice(0, 60);
      if (typeof i.IPAddress === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(i.IPAddress)) info.ip = i.IPAddress;
    } else return null;
  }
  const patch = {};
  if (Object.keys(tp).length) patch.tasmota = tp;
  if (Object.keys(sensor).length) patch.sensor = sensor;
  if (Object.keys(info).length) patch.info = info;
  if (events.length) return { family: 'tasmota', patch, events };
  return Object.keys(patch).length ? { family: 'tasmota', patch } : null;
}

/** A message of the broker → { base, family, patch } or null. */
function parse(topic, payload) {
  if (typeof topic !== 'string' || topic.length > 256) return null;
  const seg = topic.split('/');
  if (seg.length < 3 || !NAME_RE.test(seg[1])) return null;
  const base = `${seg[0]}/${seg[1]}`;
  let out = null;
  if (seg[0] === 'shellies') out = parseShelly(base, seg.slice(2), payload);
  else if (seg[0] === 'tasmota') out = parseTasmota(base, seg.slice(2), payload);
  if (!out) return null;
  return out.events ? { base, family: out.family, patch: out.patch, events: out.events } : { base, family: out.family, patch: out.patch };
}

// ─── zigbee2mqtt (the logic chains on the gateway) ───

const Z2M_ACTIONS = { single: 'single', double: 'double', triple: 'triple', hold: 'long', long: 'long' };
const Z2M_ACTION_RE = /^(?:button_)?(?:([1-8])_)?(single|double|triple|hold|long)$/;

function z2mOn(v) {
  if (v === true || v === false) return v;
  const s = String(v == null ? '' : v).toUpperCase();
  return s === 'ON' ? true : (s === 'OFF' ? false : null);
}

function parseZ2m(base, payload, info) {
  const o = json(payload);
  if (!o) return null;
  const kind = info && info.kind;
  const chs = info && Array.isArray(info.chs) ? info.chs : null;
  const patch = { ch: {}, sensor: {} };
  if (kind === 'light' || kind === 'plug') {
    const first = kind === 'light' ? 'light:0' : 'switch:0';
    if (chs && chs.length) {
      chs.forEach((c, i) => { const on = z2mOn(o[`state_${c}`]); if (on != null) patch.ch[`switch:${i}`] = { on }; });
    } else {
      const c = {};
      const on = z2mOn(o.state);
      if (on != null) c.on = on;
      const b = num(o.brightness);
      if (kind === 'light' && b != null) c.bri = Math.max(1, Math.min(100, Math.round((b * 100) / 254)));
      if (Object.keys(c).length) patch.ch[first] = c;
    }
    const w = round(o.power, 1);
    const key = chs && chs.length ? 'switch:0' : first;
    if (w != null) patch.ch[key] = { ...(patch.ch[key] || {}), power: w };
  } else if (kind === 'cover') {
    const c = {};
    const pos = pct(o.position);
    if (pos != null) c.pos = pos;
    const run = String(o.moving || o.motor_state || '').toUpperCase();
    if (run === 'UP' || run === 'OPENING') c.moving = 'opening';
    else if (run === 'DOWN' || run === 'CLOSING') c.moving = 'closing';
    else if (run === 'STOP' || run === 'STOPPED' || o.moving === false) c.moving = null;
    if (Object.keys(c).length) patch.ch['cover:0'] = c;
  }
  const t = round(o.temperature, 1);
  if (t != null) patch.sensor.temperature = t;
  const h = round(o.humidity, 1);
  if (h != null) patch.sensor.humidity = h;
  const bat = pct(o.battery);
  if (bat != null) patch.sensor.battery = bat;
  if (typeof o.contact === 'boolean') patch.sensor.open = !o.contact;
  const occ = typeof o.occupancy === 'boolean' ? o.occupancy : (typeof o.presence === 'boolean' ? o.presence : null);
  if (occ != null) patch.sensor.presence = occ;
  if (typeof o.water_leak === 'boolean') patch.sensor.water = o.water_leak;
  if (!Object.keys(patch.ch).length) delete patch.ch;
  if (!Object.keys(patch.sensor).length) delete patch.sensor;
  const m = typeof o.action === 'string' ? Z2M_ACTION_RE.exec(o.action) : null;
  const events = m ? [{ input: m[1] ? Number(m[1]) - 1 : 0, ev: Z2M_ACTIONS[m[2]] }] : null;
  if (events) return { base, family: 'z2m', patch, events };
  return Object.keys(patch).length ? { base, family: 'z2m', patch } : null;
}

// ─── Device records ─────────────────────────────

function newDevice(base, family) {
  return { base, family: family || (base.startsWith('tasmota/') ? 'tasmota' : null), online: null, ch: {}, sensor: {}, info: {}, flags: { dimmer: false, shutters: 0 }, drop: [] };
}

function mergeCh(dev, key, fields) {
  dev.ch[key] = { ...(dev.ch[key] || {}), ...fields };
}

function dropCh(dev, key) {
  if (!dev.ch[key]) return;
  delete dev.ch[key];
  if (!dev.drop.includes(key)) dev.drop.push(key);
}

/** Tasmota: POWERn → switch:n-1, but with a dimmer POWER/POWER1 is light:0 and shutter n uses POWER 2n-1 and 2n. */
function applyTasmota(dev, tp) {
  if (tp.dimmer != null && !dev.flags.dimmer) { dev.flags.dimmer = true; dropCh(dev, 'switch:0'); }
  if (tp.shutters) {
    const n = Math.max(dev.flags.shutters, ...Object.keys(tp.shutters).map(Number));
    if (n > dev.flags.shutters) {
      dev.flags.shutters = n;
      for (let i = 0; i < 2 * n; i++) dropCh(dev, `switch:${i}`);
    }
    for (const [k, v] of Object.entries(tp.shutters)) mergeCh(dev, `cover:${Number(k) - 1}`, v);
  }
  const keyOf = (n) => {
    if (dev.flags.dimmer && n === 1) return 'light:0';
    if (n <= 2 * dev.flags.shutters) return null;
    return `switch:${n - 1}`;
  };
  if (tp.dimmer != null) mergeCh(dev, 'light:0', { bri: tp.dimmer });
  for (const [k, on] of Object.entries(tp.power || {})) {
    const key = keyOf(Number(k));
    if (key) mergeCh(dev, key, { on });
  }
  if (tp.energy) {
    const first = dev.flags.shutters ? 'cover:0' : dev.flags.dimmer ? 'light:0' : 'switch:0';
    const set = (field, v) => {
      if (v == null) return;
      if (Array.isArray(v)) v.forEach((x, i) => { const key = i === 0 ? first : keyOf(i + 1); if (key && x != null) mergeCh(dev, key, { [field]: x }); });
      else mergeCh(dev, first, { [field]: v });
    };
    set('power', tp.energy.power);
    set('today', tp.energy.today);
  }
}

function apply(dev, patch) {
  if (!patch) return dev;
  if (typeof patch.online === 'boolean') dev.online = patch.online;
  for (const [k, v] of Object.entries(patch.ch || {})) mergeCh(dev, k, v);
  if (patch.tasmota) applyTasmota(dev, patch.tasmota);
  if (patch.sensor) dev.sensor = { ...dev.sensor, ...patch.sensor };
  if (patch.info) dev.info = { ...dev.info, ...patch.info };
  for (const k of Object.keys(patch.ch || {})) dev.drop = dev.drop.filter((x) => x !== k);
  return dev;
}

/** The device as the server part gets it (JSON, no internal flags). */
function snapshot(dev) {
  return {
    base: dev.base,
    family: dev.family,
    online: dev.online,
    ch: JSON.parse(JSON.stringify(dev.ch)),
    sensor: { ...dev.sensor },
    info: { ...dev.info },
    drop: dev.drop.slice(0, 16),
  };
}

module.exports = { parse, parseZ2m, apply, snapshot, newDevice };
