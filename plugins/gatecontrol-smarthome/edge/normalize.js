'use strict';

// MQTT messages of Shelly (Gen1, Gen2/3/4) and Tasmota devices → one normalised state per device.
// Pure functions, no I/O (tested with real sample messages in test/edge_normalize.test.js).
//
//   parse(topic, payload) → null (not a state message: our own commands, unknown topics, broken JSON)
//                           | { base, family, patch }
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
// sensor { temperature (°C), humidity (%), battery (%) }, online true | false | null (LWT / "online").

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const COMP_RE = /^(switch|light|cover|temperature|humidity|devicepower):(\d{1,2})$/;

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

// ─── Shelly Gen2+ (status/<component>, events/rpc NotifyStatus / NotifyFullStatus) ───

/** One Gen2 component (switch:0, cover:0, …) into the patch; unknown components are ignored. */
function gen2Component(patch, key, o) {
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
    if (!o || (o.method !== 'NotifyStatus' && o.method !== 'NotifyFullStatus') || !isObj(o.params)) return null;
    for (const [k, v] of Object.entries(o.params)) gen2Component(patch, k, v);
    if (typeof o.src === 'string' && NAME_RE.test(o.src)) patch.info = { id: o.src };
    return Object.keys(patch).length ? { family: 'shelly2', patch } : null;
  }
  // Gen1: relay/<n>[/power|/energy], roller/<n>[/pos|/power|/energy], light/<n>[/status|/power|/energy], sensor/<x>, announce
  const t = text(payload).trim();
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
  return null; // our own rpc/command topics, input events, info, …
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
    else if (prefix === 'stat' && cmd === 'RESULT') { tasmotaState(tp, o); tasmotaSensor(tp, sensor, o); }
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
  return out ? { base, family: out.family, patch: out.patch } : null;
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

module.exports = { parse, apply, snapshot, newDevice };
