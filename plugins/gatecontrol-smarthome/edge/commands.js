'use strict';

// Commands of the server part → MQTT messages for the device (pure; published by edge/index.js).
//   messages({ base, family, ch, op, value }) → [{ topic, payload }]   (throws code bad_command)
//   refresh({ base, family })                → the messages that make a device report its whole state
//
// Shelly Gen2+: JSON-RPC to <prefix>/rpc (answers go to <prefix>/gc/rpc — inside the device's own topics,
// which its account may use; nobody listens there). Gen1: relay/roller/light command topics. Tasmota:
// cmnd/POWERn, Dimmer, ShutterOpen/Close/Stop/PositionN.
//
// Since 1.12.0 also zigbee2mqtt on the gateway (family 'z2m', only for the logic chains): base
// "zigbee2mqtt/0x<IEEE address>", sent to zigbee2mqtt/<friendly name>/set — messages(cmd, { z2mTopic(base) }) names
// the friendly name (edge/index.js knows it from zigbee2mqtt/bridge/devices). Brightness 1–100 % → 3–254; covers
// OPEN / CLOSE / STOP / position.
// A channel of several outputs carries zch (the channel's zigbee2mqtt name, l1 / l2 / left …).
// Since 1.17.0 thermostats (channel thermostat:<n>, the heating — edge/heat.js and server/edge.js):
//   setpoint (value 4–31 °C, half degrees)  Shelly TRV (Gen1): <base>/thermostat/<n>/command/target_t; BLU TRV through
//                                           a BLU Gateway Gen3: RPC BluTrv.Call { id: 200 + n, method: TRV.SetTarget }
//   boost (value 0–120 minutes, 0 = end)    Gen1 only: <base>/thermostat/<n>/command/boost_minutes
//   schedule_off                            Gen1 only: <base>/thermostat/<n>/command/schedule 0 (its own plan off)
//   check(cmd) → the same checks without a topic (the logic chains check their steps before they run)
// Since 1.18.0 also zigbee2mqtt thermostats (family 'z2m', channel thermostat:0, the heating only — edge/heat.js), one
// message to zigbee2mqtt/<friendly name>/set as zigbee2mqtt offers it itself:
//   setpoint (value 4–31 °C; prop occupied_heating_setpoint | current_heating_setpoint, what the device exposes)
//   mode     (value off | heat | auto → system_mode)
// Since 1.19.0 also the device's own boost (only when its exposes name it — edge/index.js boostOf):
//   boost    (value true | false; prop boost_heating | boost, on / off its value_on / value_off)
// Since 1.21.0 Tuya devices in the home network (family 'tuya', base "tuya/<device id>", edge/tuya.js): no MQTT — the
// message is { tuya: { base, ch, op, value } }, edge/index.js writes it over the device's TCP connection (which
// datapoints: edge/tuya.js toDps with the device's profile). Lights also take ct (mired 153–500), color ({ hue 0–65535,
// sat 0–254 }) and scene (night | read | work | leisure).

const BASE_RE = /^(?:(shellies|tasmota)\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}|zigbee2mqtt\/0x[0-9a-f]{16}|tuya\/[A-Za-z0-9]{8,32})$/;
const TUYA_RE = /^tuya\/[A-Za-z0-9]{8,32}$/;
const TUYA_SCENES = ['night', 'read', 'work', 'leisure'];
const Z2M_RE = /^zigbee2mqtt\/0x[0-9a-f]{16}$/;
const CH_RE = /^(switch|light|cover|thermostat):(\d{1,2})$/;
const OPS = {
  switch: ['on', 'off'],
  light: ['on', 'off', 'bri', 'ct', 'color', 'scene'],
  cover: ['open', 'close', 'stop', 'pos'],
  thermostat: ['setpoint', 'boost', 'schedule_off', 'mode', 'calibration'],
};
const Z2M_SETPOINTS = ['occupied_heating_setpoint', 'current_heating_setpoint'];
const Z2M_MODES = ['off', 'heat', 'auto'];
const Z2M_BOOSTS = ['boost_heating', 'boost'];
// since 1.20.0: the correction of the measured temperature a zigbee2mqtt thermostat takes itself (Versatz)
const Z2M_CAL = 'local_temperature_calibration';
/** value_on / value_off of a binary zigbee2mqtt property: a short string or true / false. */
const z2mBin = (v) => (typeof v === 'string' && v.length >= 1 && v.length <= 16) || typeof v === 'boolean';

function bad(msg) { return Object.assign(new Error(msg), { code: 'bad_command' }); }

let rpcId = 0;
function rpc(base, method, params) {
  rpcId = (rpcId % 1e6) + 1;
  return { topic: `${base}/rpc`, payload: JSON.stringify({ id: rpcId, src: `${base}/gc`, method, params }) };
}

/** zigbee2mqtt: the JSON of the /set message. */
function z2mPayload(c, type, value) {
  if (type === 'thermostat') {
    if (c.op === 'mode') return { system_mode: value };
    if (c.op === 'boost') return { [c.prop]: value ? c.on : c.off };
    if (c.op === 'calibration') return { [Z2M_CAL]: value };
    return { [c.prop]: value };
  }
  if (type === 'cover') {
    if (c.op === 'pos') return { position: value };
    return { state: { open: 'OPEN', close: 'CLOSE', stop: 'STOP' }[c.op] };
  }
  const key = c.zch ? `state_${c.zch}` : 'state';
  if (c.op === 'bri') return { state: 'ON', brightness: Math.max(1, Math.round((value * 254) / 100)) };
  return { [key]: c.op === 'on' ? 'ON' : 'OFF' };
}

const CHS_RE = /^[a-z0-9_]{1,8}$/;

/** The checks of messages() — throws bad_command; → { type, idx, value }. */
function check(cmd) {
  const c = cmd && typeof cmd === 'object' ? cmd : {};
  if (typeof c.base !== 'string' || !BASE_RE.test(c.base)) throw bad('invalid base');
  const m = typeof c.ch === 'string' ? CH_RE.exec(c.ch) : null;
  if (!m) throw bad('invalid channel');
  const [, type, idxStr] = m;
  const idx = Number(idxStr);
  if (!OPS[type].includes(c.op)) throw bad('invalid operation');
  let value = null;
  if ((c.family === 'tuya') !== TUYA_RE.test(c.base)) throw bad('unknown device family');
  if (c.family !== 'tuya' && ['ct', 'color', 'scene'].includes(c.op)) throw bad('invalid operation');
  if (c.family === 'tuya') {
    if (type !== 'switch' && type !== 'light') throw bad('invalid channel');
    if (c.op === 'bri') {
      value = typeof c.value === 'number' && Number.isFinite(c.value) ? Math.round(c.value) : NaN;
      if (!(value >= 1 && value <= 100)) throw bad('invalid value');
    } else if (c.op === 'ct') {
      value = typeof c.value === 'number' && Number.isFinite(c.value) ? Math.round(c.value) : NaN;
      if (!(value >= 153 && value <= 500)) throw bad('invalid value');
    } else if (c.op === 'color') {
      const v = c.value && typeof c.value === 'object' ? c.value : {};
      const ok = (n, hi) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= hi;
      if (!ok(v.hue, 65535) || !ok(v.sat, 254)) throw bad('invalid value');
      value = { hue: Math.round(v.hue), sat: Math.round(v.sat) };
    } else if (c.op === 'scene') {
      if (!TUYA_SCENES.includes(c.value)) throw bad('invalid value');
      value = c.value;
    }
    if (type === 'switch' && c.op !== 'on' && c.op !== 'off') throw bad('invalid operation');
    if (c.zch != null) throw bad('invalid channel');
    return { type, idx, value };
  }
  if (type === 'thermostat' && c.family === 'z2m') {
    if (idx !== 0 || !['setpoint', 'mode', 'boost', 'calibration'].includes(c.op)) throw bad('invalid operation');
    if (c.op === 'calibration') {
      value = typeof c.value === 'number' && Number.isFinite(c.value) ? Math.round(c.value * 10) / 10 : NaN;
      if (!(value >= -10 && value <= 10)) throw bad('invalid value');
    } else if (c.op === 'mode') {
      if (!Z2M_MODES.includes(c.value)) throw bad('invalid value');
      value = c.value;
    } else if (c.op === 'boost') {
      if (!Z2M_BOOSTS.includes(c.prop) || !z2mBin(c.on) || !z2mBin(c.off) || c.on === c.off) throw bad('invalid operation');
      if (typeof c.value !== 'boolean') throw bad('invalid value');
      value = c.value;
    } else {
      if (!Z2M_SETPOINTS.includes(c.prop)) throw bad('invalid operation');
      value = typeof c.value === 'number' && Number.isFinite(c.value) ? Math.round(c.value * 10) / 10 : NaN;
      if (!(value >= 4 && value <= 31)) throw bad('invalid value');
    }
  } else if (type === 'thermostat') {
    if (c.op === 'calibration') throw bad('invalid operation');
    if ((c.family !== 'shelly1' && !(c.family === 'shelly2' && c.op === 'setpoint')) || c.op === 'mode') throw bad('invalid operation');
    if (c.op === 'setpoint') {
      value = typeof c.value === 'number' && Number.isFinite(c.value) ? Math.round(c.value * 2) / 2 : NaN;
      if (!(value >= 4 && value <= 31)) throw bad('invalid value');
    } else if (c.op === 'boost') {
      value = typeof c.value === 'number' && Number.isFinite(c.value) ? Math.round(c.value) : NaN;
      if (!(value >= 0 && value <= 120)) throw bad('invalid value');
    }
  } else if (c.op === 'bri' || c.op === 'pos') {
    value = typeof c.value === 'number' && Number.isFinite(c.value) ? Math.round(c.value) : NaN;
    if (!(value >= (c.op === 'bri' ? 1 : 0) && value <= 100)) throw bad('invalid value');
  }
  if ((c.family === 'z2m') !== Z2M_RE.test(c.base)) throw bad('unknown device family');
  if (c.family === 'z2m') {
    if (c.zch != null && !(typeof c.zch === 'string' && CHS_RE.test(c.zch))) throw bad('invalid channel');
  } else if (!['shelly1', 'shelly2', 'tasmota'].includes(c.family)) throw bad('unknown device family');
  return { type, idx, value };
}

function messages(cmd, opts = {}) {
  const c = cmd && typeof cmd === 'object' ? cmd : {};
  const { type, idx, value } = check(c);
  const { base, family } = c;
  if (family === 'tuya') return [{ tuya: { base, ch: c.ch, op: c.op, ...(value != null ? { value } : {}) } }];
  if (family === 'z2m') {
    const name = typeof opts.z2mTopic === 'function' ? opts.z2mTopic(base) : null;
    if (typeof name !== 'string' || !name || name.length > 128) throw bad('unknown zigbee2mqtt device');
    return [{ topic: `zigbee2mqtt/${name}/set`, payload: JSON.stringify(z2mPayload(c, type, value)) }];
  }
  if (type === 'thermostat') {
    if (family === 'shelly2') return [rpc(base, 'BluTrv.Call', { id: 200 + idx, method: 'TRV.SetTarget', params: { id: 0, target_C: value } })];
    const t = `${base}/thermostat/${idx}/command`;
    if (c.op === 'setpoint') return [{ topic: `${t}/target_t`, payload: String(value) }];
    if (c.op === 'boost') return [{ topic: `${t}/boost_minutes`, payload: String(value) }];
    return [{ topic: `${t}/schedule`, payload: '0' }];
  }
  if (family === 'shelly2') {
    if (type === 'switch') return [rpc(base, 'Switch.Set', { id: idx, on: c.op === 'on' })];
    if (type === 'light') return [rpc(base, 'Light.Set', c.op === 'bri' ? { id: idx, on: true, brightness: value } : { id: idx, on: c.op === 'on' })];
    if (c.op === 'pos') return [rpc(base, 'Cover.GoToPosition', { id: idx, pos: value })];
    return [rpc(base, { open: 'Cover.Open', close: 'Cover.Close', stop: 'Cover.Stop' }[c.op], { id: idx })];
  }
  if (family === 'shelly1') {
    if (type === 'switch') return [{ topic: `${base}/relay/${idx}/command`, payload: c.op }];
    if (type === 'light') return [{ topic: `${base}/light/${idx}/set`, payload: JSON.stringify(c.op === 'bri' ? { turn: 'on', brightness: value } : { turn: c.op }) }];
    if (c.op === 'pos') return [{ topic: `${base}/roller/${idx}/command/pos`, payload: String(value) }];
    return [{ topic: `${base}/roller/${idx}/command`, payload: c.op }];
  }
  if (family === 'tasmota') {
    const n = idx + 1;
    if (type === 'switch') return [{ topic: `${base}/cmnd/POWER${n}`, payload: c.op === 'on' ? 'ON' : 'OFF' }];
    if (type === 'light') return c.op === 'bri' ? [{ topic: `${base}/cmnd/Dimmer`, payload: String(value) }] : [{ topic: `${base}/cmnd/POWER1`, payload: c.op === 'on' ? 'ON' : 'OFF' }];
    if (c.op === 'pos') return [{ topic: `${base}/cmnd/ShutterPosition${n}`, payload: String(value) }];
    return [{ topic: `${base}/cmnd/Shutter${{ open: 'Open', close: 'Close', stop: 'Stop' }[c.op]}${n}`, payload: '' }];
  }
  throw bad('unknown device family');
}

function refresh(dev) {
  if (!dev || typeof dev.base !== 'string' || !BASE_RE.test(dev.base)) return [];
  if (dev.family === 'shelly2') return [{ topic: `${dev.base}/command`, payload: 'status_update' }];
  if (dev.family === 'shelly1') return [{ topic: `${dev.base}/command`, payload: 'update' }];
  if (dev.family === 'tasmota') return [{ topic: `${dev.base}/cmnd/STATUS`, payload: '11' }, { topic: `${dev.base}/cmnd/STATUS`, payload: '10' }];
  return []; // tuya: edge/index.js asks the device over its connection
}

module.exports = { messages, check, refresh, BASE_RE, Z2M_RE, TUYA_RE, TUYA_SCENES, Z2M_SETPOINTS, Z2M_MODES, Z2M_BOOSTS, Z2M_CAL, z2mBin };
