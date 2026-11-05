'use strict';

// Commands of the server part → MQTT messages for the device (pure; published by edge/index.js).
//   messages({ base, family, ch, op, value }) → [{ topic, payload }]   (throws code bad_command)
//   refresh({ base, family })                → the messages that make a device report its whole state
//
// Shelly Gen2+: JSON-RPC to <prefix>/rpc (answers go to <prefix>/gc/rpc — inside the device's own topics,
// which its account may use; nobody listens there). Gen1: relay/roller/light command topics. Tasmota:
// cmnd/POWERn, Dimmer, ShutterOpen/Close/Stop/PositionN.

const BASE_RE = /^(shellies|tasmota)\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const CH_RE = /^(switch|light|cover):(\d{1,2})$/;
const OPS = {
  switch: ['on', 'off'],
  light: ['on', 'off', 'bri'],
  cover: ['open', 'close', 'stop', 'pos'],
};

function bad(msg) { return Object.assign(new Error(msg), { code: 'bad_command' }); }

let rpcId = 0;
function rpc(base, method, params) {
  rpcId = (rpcId % 1e6) + 1;
  return { topic: `${base}/rpc`, payload: JSON.stringify({ id: rpcId, src: `${base}/gc`, method, params }) };
}

function messages(cmd) {
  const c = cmd && typeof cmd === 'object' ? cmd : {};
  if (typeof c.base !== 'string' || !BASE_RE.test(c.base)) throw bad('invalid base');
  const m = typeof c.ch === 'string' ? CH_RE.exec(c.ch) : null;
  if (!m) throw bad('invalid channel');
  const [, type, idxStr] = m;
  const idx = Number(idxStr);
  if (!OPS[type].includes(c.op)) throw bad('invalid operation');
  let value = null;
  if (c.op === 'bri' || c.op === 'pos') {
    value = typeof c.value === 'number' && Number.isFinite(c.value) ? Math.round(c.value) : NaN;
    if (!(value >= (c.op === 'bri' ? 1 : 0) && value <= 100)) throw bad('invalid value');
  }
  const { base, family } = c;
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
  return [];
}

module.exports = { messages, refresh, BASE_RE };
