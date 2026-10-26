'use strict';

// Smart Home notifications (plugin.json notifyTopics) from the background
// sync — no extra requests to the gateways. After every background run the
// gateways' sensors are compared with the last seen state (kept in
// gc.storage, so a restart neither repeats nor loses anything):
//
//   alarm                water / smoke / CO / alarm sensor triggers (priority high);
//                        an all-clear replaces it (same collapse key) when it ends
//   window_open          contact open longer than N minutes (setting, default 15);
//                        on a gateway with thermostats only while one of them heats
//   battery_low          sensor battery below the threshold (setting, default 15 %)
//                        or "low battery": once per device and day, one message per gateway
//                        (1.6.1: the sensors of one device — same uniqueid before the first "-" —
//                        are one entry, not one per sensor)
//   gateway_unreachable  gateway not answering for 5 minutes (priority high);
//                        "reachable again" replaces it (same collapse key)
//
// A gateway or sensor seen for the first time (also: the very first run)
// only records its state: nothing that was already the case is announced.

const store = require('./store');
const notify = require('./notify');

const STATE_KEY = 'notify.state';
const WINDOW_DEFAULT_MIN = 15;
const BATTERY_DEFAULT = 15;
const GATEWAY_DOWN_MIN = 5;

const TEXTS = {
  de: {
    'alarm.water': 'Wasser erkannt',
    'alarm.smoke': 'Rauch erkannt',
    'alarm.co': 'Kohlenmonoxid erkannt',
    'alarm.alarm': 'Alarm ausgelöst',
    'alarm.clear': 'Entwarnung',
    'alarm.clear.body': '{{name}} meldet keinen Alarm mehr',
    'window.title': 'Fenster offen',
    'window.body': '{{name}} ist seit {{min}} Minuten offen',
    'window.heating': 'die Heizung läuft',
    'battery.title': 'Batterie schwach',
    'battery.empty': 'fast leer',
    'gateway.down': 'Gateway nicht erreichbar',
    'gateway.down.body': '{{name}} antwortet seit {{min}} Minuten nicht',
    'gateway.up': 'Gateway wieder erreichbar',
    'gateway.up.body': '{{name}} antwortet wieder',
    'fact.sensor': 'Sensor',
    'fact.gateway': 'Gateway',
  },
  en: {
    'alarm.water': 'Water detected',
    'alarm.smoke': 'Smoke detected',
    'alarm.co': 'Carbon monoxide detected',
    'alarm.alarm': 'Alarm triggered',
    'alarm.clear': 'All clear',
    'alarm.clear.body': '{{name}} no longer reports an alarm',
    'window.title': 'Window open',
    'window.body': '{{name}} has been open for {{min}} minutes',
    'window.heating': 'the heating is on',
    'battery.title': 'Battery low',
    'battery.empty': 'almost empty',
    'gateway.down': 'Gateway unreachable',
    'gateway.down.body': '{{name}} has not answered for {{min}} minutes',
    'gateway.up': 'Gateway reachable again',
    'gateway.up.body': '{{name}} answers again',
    'fact.sensor': 'Sensor',
    'fact.gateway': 'Gateway',
  },
};

/** Thresholds from the plugin settings (out-of-range values fall back to the defaults). */
function configOf(settings) {
  const s = settings || {};
  const win = Number(s.notify_window_min);
  const bat = Number(s.notify_battery_low);
  return {
    windowMin: Number.isFinite(win) && win >= 5 && win <= 240 ? win : WINDOW_DEFAULT_MIN,
    batteryLow: Number.isFinite(bat) && bat >= 5 && bat <= 50 ? bat : BATTERY_DEFAULT,
    gatewayDownMin: GATEWAY_DOWN_MIN,
    lang: notify.langOf(s),
  };
}

/** Local calendar day (the plugin process runs in the server's TZ). */
function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const sensorKey = (o) => (o.uniqueid ? `u:${o.uniqueid}` : `i:${o.id}`);

// One physical device shows up in deCONZ as several sensors (a motion sensor: presence, light
// level, temperature — "00:15:8d:…-01-0406", "…-01-0400", "…-01-0402"), all with the same name
// and battery. The device is the uniqueid up to the first "-" (no uniqueid: the name).
const deviceKey = (o) => (o.uniqueid ? `u:${String(o.uniqueid).split('-')[0].toLowerCase()}` : `n:${o.name}`);

/** The weak batteries of a gateway, one entry per device (the lowest value of its sensors). */
function byDevice(list) {
  const out = new Map();
  for (const o of list) {
    const k = deviceKey(o);
    const prev = out.get(k);
    if (!prev || (o.battery != null && (prev.battery == null || o.battery < prev.battery))) out.set(k, o);
  }
  return [...out.values()];
}

/**
 * Pure transition logic.
 * @param {object|null} prevMemo  last stored state (null = first run)
 * @param {Array<{ gateway: { id, name }, reachable: boolean, sensors: object[] }>} results  of the background sync
 * @param {{ windowMin, batteryLow, gatewayDownMin }} cfg
 * @param {number} now  ms
 * @returns {{ memo, events: Array<{ topic, kind, gateway, sensor?, items?, minutes? }> }}
 */
function evaluate(prevMemo, results, cfg, now) {
  const today = dayOf(now);
  const memo = { v: 1, gateways: {} };
  const events = [];
  for (const r of results || []) {
    if (!r || !r.gateway) continue;
    const gw = r.gateway;
    const prevG = prevMemo ? ((prevMemo.gateways || {})[gw.id] || null) : null;
    const g = { down: null, downSince: null, sensors: {} };

    // gateway_unreachable: down = 'pending' | 'announced' | 'muted' (was already down at the first sighting)
    if (!r.reachable) {
      const wasDown = !!(prevG && prevG.downSince != null);
      g.downSince = wasDown ? prevG.downSince : now;
      g.down = wasDown ? prevG.down : (prevG ? 'pending' : 'muted');
      if (g.down === 'pending' && now - g.downSince >= cfg.gatewayDownMin * 60000) {
        events.push({ topic: 'gateway_unreachable', kind: 'down', gateway: gw, minutes: Math.round((now - g.downSince) / 60000) });
        g.down = 'announced';
      }
      g.sensors = prevG ? prevG.sensors || {} : {}; // nothing new about the sensors
      memo.gateways[gw.id] = g;
      continue;
    }
    if (prevG && prevG.down === 'announced') events.push({ topic: 'gateway_unreachable', kind: 'up', gateway: gw });

    const sensors = r.sensors || [];
    const hasThermostat = sensors.some((o) => o.thermostat);
    const heating = sensors.some((o) => o.thermostat && o.heating);
    const lowBatteries = [];
    for (const o of sensors) {
      const key = sensorKey(o);
      const prevS = prevG ? ((prevG.sensors || {})[key] || null) : null;
      const cur = {};

      // alarm: null | 'announced' | 'muted'
      if (o.alarm === true) {
        if (!prevS) cur.alarm = 'muted';
        else if (prevS.alarm) cur.alarm = prevS.alarm;
        else { events.push({ topic: 'alarm', kind: o.alarmKind || 'alarm', gateway: gw, sensor: o }); cur.alarm = 'announced'; }
      } else if (o.alarm === false) {
        if (prevS && prevS.alarm === 'announced') events.push({ topic: 'alarm', kind: 'clear', gateway: gw, sensor: o });
        cur.alarm = null;
      } else cur.alarm = prevS ? prevS.alarm || null : null;

      // window_open: open = null | 'pending' | 'announced' | 'muted'
      if (o.open === true) {
        const wasOpen = !!(prevS && prevS.openSince != null);
        cur.openSince = wasOpen ? prevS.openSince : now;
        cur.open = wasOpen ? prevS.open : (prevS ? 'pending' : 'muted');
        const minutes = (now - cur.openSince) / 60000;
        if (cur.open === 'pending' && minutes >= cfg.windowMin && (!hasThermostat || heating)) {
          events.push({ topic: 'window_open', kind: heating ? 'heating' : 'open', gateway: gw, sensor: o, minutes: Math.round(minutes) });
          cur.open = 'announced';
        }
      } else if (o.open === false) {
        cur.openSince = null;
        cur.open = null;
      } else {
        cur.openSince = prevS ? prevS.openSince ?? null : null;
        cur.open = prevS ? prevS.open || null : null;
      }

      // battery_low: once per device and day
      cur.batteryDay = prevS ? prevS.batteryDay || null : null;
      const low = (o.battery != null && o.battery < cfg.batteryLow) || o.lowBattery;
      if (low && cur.batteryDay !== today) {
        if (prevS) lowBatteries.push(o);
        cur.batteryDay = today;
      }

      g.sensors[key] = cur;
    }
    if (lowBatteries.length) events.push({ topic: 'battery_low', kind: 'low', gateway: gw, items: byDevice(lowBatteries) });
    memo.gateways[gw.id] = g;
  }
  // gateways without a result this time (sync error, disabled): keep what was known
  for (const [id, g] of Object.entries((prevMemo && prevMemo.gateways) || {})) {
    if (!(id in memo.gateways)) memo.gateways[id] = g;
  }
  return { memo, events };
}

/** Event → gc.notify payload. `owners` = user ids the sensor is assigned to (empty: the topic's rule decides). */
function toNotification(gc, ev, cfg, owners) {
  const lang = cfg.lang;
  const tx = (k, p) => notify.fmt(TEXTS, lang, k, p);
  const gwName = ev.gateway.name || `Gateway ${ev.gateway.id}`;
  const facts = [];
  const base = { ...notify.openAction(gc, lang), gateway_id: ev.gateway.id };
  if (ev.sensor) {
    facts.push({ label: tx('fact.sensor'), value: ev.sensor.name });
    facts.push({ label: tx('fact.gateway'), value: gwName });
  }

  if (ev.topic === 'alarm') {
    const collapseKey = `alarm:${ev.gateway.id}:${ev.sensor.id}`;
    if (ev.kind === 'clear') {
      return { topic: 'alarm', title: tx('alarm.clear'), body: tx('alarm.clear.body', { name: ev.sensor.name }), priority: 'info', collapseKey, ttl: 12 * 3600, users: null, data: { ...base, facts } };
    }
    return {
      topic: 'alarm', title: tx(`alarm.${['water', 'smoke', 'co'].includes(ev.kind) ? ev.kind : 'alarm'}`), body: `${ev.sensor.name} · ${gwName}`,
      priority: 'high', collapseKey, ttl: 24 * 3600, users: null, data: { ...base, alarm: ev.kind, facts },
    };
  }
  if (ev.topic === 'window_open') {
    const body = tx('window.body', { name: ev.sensor.name, min: notify.num(ev.minutes, lang) }) + (ev.kind === 'heating' ? ` – ${tx('window.heating')}` : '');
    return {
      topic: 'window_open', title: tx('window.title'), body, priority: 'normal', collapseKey: `window:${ev.gateway.id}:${ev.sensor.id}`, ttl: 6 * 3600,
      users: owners && owners.length ? owners : null, data: { ...base, facts },
    };
  }
  if (ev.topic === 'battery_low') {
    const items = ev.items.slice(0, 20);
    const body = items.map((o) => `${o.name} ${o.battery != null ? `${notify.num(o.battery, lang)} %` : tx('battery.empty')}`).join(', ')
      + (ev.items.length > items.length ? ` (+${ev.items.length - items.length})` : '');
    return {
      topic: 'battery_low', title: tx('battery.title'), body: `${body} · ${gwName}`, priority: 'info', collapseKey: `battery:${ev.gateway.id}`, ttl: 24 * 3600, users: null,
      data: { ...base, facts: items.slice(0, 10).map((o) => ({ label: o.name, value: o.battery != null ? `${notify.num(o.battery, lang)} %` : tx('battery.empty') })) },
    };
  }
  // gateway_unreachable
  const collapseKey = `gateway:${ev.gateway.id}`;
  if (ev.kind === 'up') {
    return { topic: 'gateway_unreachable', title: tx('gateway.up'), body: tx('gateway.up.body', { name: gwName }), priority: 'info', collapseKey, ttl: 12 * 3600, users: null, data: base };
  }
  return {
    topic: 'gateway_unreachable', title: tx('gateway.down'), body: tx('gateway.down.body', { name: gwName, min: notify.num(ev.minutes, lang) }),
    priority: 'high', collapseKey, ttl: 24 * 3600, users: null, data: base,
  };
}

// ─── Glue (one check at a time) ─────────────────

let notifier = null;
let chain = Promise.resolve();

function reset() { notifier = null; }

/** Owners of the sensors in window events: { 'gw:deconzId' → [user ids] }. */
async function sensorOwners(gc, events) {
  const out = new Map();
  const gwIds = [...new Set(events.filter((e) => e.topic === 'window_open').map((e) => e.gateway.id))];
  if (!gwIds.length) return out;
  const owners = await store.allOwners(gc);
  for (const gid of gwIds) {
    for (const r of await store.listResources(gc, gid)) {
      if (r.deconz_type === 'sensors') out.set(`${gid}:${r.deconz_id}`, owners.get(r.id) || []);
    }
  }
  return out;
}

/** Compare the background sync's results with the last seen state and send what changed. */
function check(gc, results, { now = Date.now() } = {}) {
  const run = async () => {
    if (!notifier) notifier = notify.createNotifier(gc);
    const prev = await notify.loadState(gc, STATE_KEY);
    const cfg = configOf(await gc.settings.all());
    // gateways that no longer exist leave the stored state
    const known = new Set((await store.listGateways(gc)).map((g) => String(g.id)));
    const prevKnown = prev ? { ...prev, gateways: Object.fromEntries(Object.entries(prev.gateways || {}).filter(([id]) => known.has(id))) } : null;
    const { memo, events } = evaluate(prevKnown, results, cfg, now);
    const owners = events.length ? await sensorOwners(gc, events) : new Map();
    for (const ev of events) {
      const own = ev.sensor ? owners.get(`${ev.gateway.id}:${ev.sensor.id}`) || [] : [];
      await notifier.send(toNotification(gc, ev, cfg, own), { minGapMs: ev.topic === 'battery_low' ? 3600000 : 0 });
    }
    await notify.saveState(gc, STATE_KEY, memo, prev ? JSON.stringify(prev) : null);
    return events.length;
  };
  const p = chain.then(run, run);
  chain = p.catch((e) => { gc.log.warn('notification check failed', (e && e.code) || (e && e.message)); });
  return p;
}

module.exports = { evaluate, toNotification, configOf, check, reset, dayOf, STATE_KEY, TEXTS };
