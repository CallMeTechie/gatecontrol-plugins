'use strict';

// Vehicle notifications (plugin.json notifyTopics) from the state the plugin
// already polls — no extra requests to the Škoda cloud. After every
// successful sync the vehicles' state is compared with the last seen state
// (kept in gc.storage, so a restart neither repeats nor loses anything):
//
//   charging_done  CHARGING → not charging at the charge target (or CONSERVING)
//   battery_low    charge level below the threshold (setting, default 20 %),
//                  once per drop; again only after it was 5 points above it
//   not_locked     unlocked for longer than N minutes (setting, default 15),
//                  once until the vehicle is locked again
//   climate_done   climatisation reached its target or ended, once per run
//
// A vehicle seen for the first time (also: the very first run) only records
// its state: nothing that was already the case is announced.

const store = require('./store');
const notify = require('./notify');

const STATE_KEY = 'notify.state';
const BATTERY_DEFAULT = 20;
const UNLOCKED_DEFAULT_MIN = 15;
const BATTERY_HYSTERESIS = 5;
const CLIMATE_IDLE = new Set(['OFF', 'INVALID', 'UNKNOWN', 'ERROR']);
const CHARGE_DONE_STATES = new Set(['CONSERVING', 'CHARGED', 'FULLY_CHARGED']);

const TEXTS = {
  de: {
    'charging_done.title': 'Laden abgeschlossen',
    'battery_low.title': 'Akku niedrig',
    'not_locked.title': 'Fahrzeug nicht verriegelt',
    'not_locked.body': '{{name}} ist seit {{min}} Minuten entriegelt',
    'climate_reached.title': 'Zieltemperatur erreicht',
    'climate_finished.title': 'Klimatisierung beendet',
    'fact.battery': 'Akku',
    'fact.range': 'Reichweite',
    'fact.target': 'Ladeziel',
    'fact.temp': 'Zieltemperatur',
    range: 'ca. {{km}} km',
  },
  en: {
    'charging_done.title': 'Charging complete',
    'battery_low.title': 'Battery low',
    'not_locked.title': 'Vehicle not locked',
    'not_locked.body': '{{name}} has been unlocked for {{min}} minutes',
    'climate_reached.title': 'Target temperature reached',
    'climate_finished.title': 'Climate control finished',
    'fact.battery': 'Battery',
    'fact.range': 'Range',
    'fact.target': 'Charge target',
    'fact.temp': 'Target temperature',
    range: 'approx. {{km}} km',
  },
};

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const upper = (v) => (v == null || v === '' ? null : String(v).toUpperCase());

/** Thresholds from the plugin settings (out-of-range values fall back to the defaults). */
function configOf(settings) {
  const s = settings || {};
  const bat = Number(s.notify_battery_low);
  const unl = Number(s.notify_unlocked_min);
  return {
    batteryLow: Number.isFinite(bat) && bat >= 5 && bat <= 80 ? bat : BATTERY_DEFAULT,
    unlockedMin: Number.isFinite(unl) && unl >= 5 && unl <= 720 ? unl : UNLOCKED_DEFAULT_MIN,
    lang: notify.langOf(s),
  };
}

/**
 * Pure transition logic.
 * @param {object|null} prevMemo  last stored state (null = first run)
 * @param {Array<{id, vin, name, model, state}>} vehicles
 * @param {{batteryLow, unlockedMin}} cfg
 * @param {number} now  ms
 * @returns {{ memo: object, events: Array<{ topic, kind, vin, vehicleId, name, state }> }}
 */
function evaluate(prevMemo, vehicles, cfg, now) {
  const prevVehicles = (prevMemo && prevMemo.vehicles) || {};
  const memo = { v: 1, vehicles: {} };
  const events = [];
  for (const v of vehicles || []) {
    if (!v || !v.vin) continue;
    const prev = prevMemo ? prevVehicles[v.vin] || null : null;
    const s = v.state;
    if (!s || typeof s !== 'object') {
      if (prev) memo.vehicles[v.vin] = prev; // no state this time: keep what we knew
      continue;
    }
    const ev = (topic, kind) => events.push({ topic, kind, vin: v.vin, vehicleId: v.id, name: v.name || v.model || v.vin, state: s });
    const cur = {};
    const soc = numOrNull(s.soc);
    const ch = s.charging || {};
    const chState = upper(ch.state);

    // charging_done
    cur.charging = chState || (prev ? prev.charging : null);
    if (prev && prev.charging === 'CHARGING' && chState && chState !== 'CHARGING') {
      const target = numOrNull(ch.targetPercent);
      const atTarget = CHARGE_DONE_STATES.has(chState)
        || (soc != null && target != null && soc >= target - 1)
        || (soc != null && soc >= 99);
      if (atTarget) ev('charging_done', 'done');
    }

    // battery_low (not while charging)
    cur.lowNotified = prev ? !!prev.lowNotified : false;
    if (soc != null) {
      if (soc < cfg.batteryLow) {
        if (!prev) cur.lowNotified = true;
        else if (!cur.lowNotified && chState !== 'CHARGING') { ev('battery_low', 'low'); cur.lowNotified = true; }
      } else if (soc >= cfg.batteryLow + BATTERY_HYSTERESIS) cur.lowNotified = false;
    }

    // not_locked
    if (s.locked === false) {
      const wasUnlocked = !!(prev && prev.unlockedSince != null);
      cur.unlockedSince = wasUnlocked ? prev.unlockedSince : now;
      cur.unlockNotified = prev ? (wasUnlocked ? !!prev.unlockNotified : false) : true;
      if (!cur.unlockNotified && now - cur.unlockedSince >= cfg.unlockedMin * 60000) { ev('not_locked', 'unlocked'); cur.unlockNotified = true; }
    } else if (s.locked === true) {
      cur.unlockedSince = null;
      cur.unlockNotified = false;
    } else {
      cur.unlockedSince = prev ? prev.unlockedSince ?? null : null;
      cur.unlockNotified = prev ? !!prev.unlockNotified : false;
    }

    // climate_done
    const climate = s.climate || {};
    const clState = upper(climate.state);
    const active = clState == null ? null : !CLIMATE_IDLE.has(clState);
    if (active === true) {
      if (!prev) { cur.climateActive = true; cur.climateNotified = true; } else if (!prev.climateActive) { cur.climateActive = true; cur.climateNotified = false; } else { cur.climateActive = true; cur.climateNotified = !!prev.climateNotified; }
      if (prev && !cur.climateNotified && climate.remainingMin === 0) { ev('climate_done', 'reached'); cur.climateNotified = true; }
    } else if (active === false) {
      if (prev && prev.climateActive && !prev.climateNotified) ev('climate_done', 'finished');
      cur.climateActive = false;
      cur.climateNotified = false;
    } else {
      cur.climateActive = prev ? !!prev.climateActive : false;
      cur.climateNotified = prev ? !!prev.climateNotified : false;
    }

    memo.vehicles[v.vin] = cur;
  }
  return { memo, events };
}

/** Event → gc.notify payload. `owners` = user ids the vehicle is assigned to (empty: the topic's rule decides). */
function toNotification(gc, ev, cfg, owners) {
  const lang = cfg.lang;
  const tx = (k, p) => notify.fmt(TEXTS, lang, k, p);
  const s = ev.state || {};
  const soc = numOrNull(s.soc);
  const range = numOrNull(s.rangeKm);
  const facts = [];
  if (soc != null) facts.push({ label: tx('fact.battery'), value: `${notify.num(soc, lang)} %` });
  if (range != null) facts.push({ label: tx('fact.range'), value: `${notify.num(range, lang)} km` });
  const levelBody = [ev.name, soc != null ? `${notify.num(soc, lang)} %` : null, range != null ? tx('range', { km: notify.num(range, lang) }) : null].filter(Boolean).join(' · ');

  let title;
  let body;
  let priority = 'normal';
  let collapseKey;
  let ttl;
  if (ev.topic === 'charging_done') {
    title = tx('charging_done.title');
    body = levelBody;
    const target = numOrNull(s.charging && s.charging.targetPercent);
    if (target != null) facts.push({ label: tx('fact.target'), value: `${notify.num(target, lang)} %` });
    collapseKey = `charge:${ev.vin}`;
    ttl = 12 * 3600;
  } else if (ev.topic === 'battery_low') {
    title = tx('battery_low.title');
    body = levelBody;
    collapseKey = `battery:${ev.vin}`;
    ttl = 24 * 3600;
  } else if (ev.topic === 'not_locked') {
    title = tx('not_locked.title');
    body = tx('not_locked.body', { name: ev.name, min: notify.num(cfg.unlockedMin, lang) });
    collapseKey = `lock:${ev.vin}`;
    ttl = 6 * 3600;
  } else {
    title = tx(ev.kind === 'reached' ? 'climate_reached.title' : 'climate_finished.title');
    const temp = numOrNull(s.climate && s.climate.targetC);
    body = [ev.name, temp != null ? `${notify.num(temp, lang, 1)} °C` : null].filter(Boolean).join(' · ');
    if (temp != null) facts.unshift({ label: tx('fact.temp'), value: `${notify.num(temp, lang, 1)} °C` });
    priority = 'info';
    collapseKey = `climate:${ev.vin}`;
    ttl = 3 * 3600;
  }
  return {
    topic: ev.topic, title, body, priority, collapseKey, ttl,
    users: owners && owners.length ? owners : null,
    data: { ...notify.openAction(gc, lang), vehicle_id: ev.vehicleId, facts },
  };
}

// ─── Glue (one check at a time) ─────────────────

let notifier = null;
let chain = Promise.resolve();

function reset() { notifier = null; }

/** Compare the stored vehicles with the last seen state and send what changed. */
function check(gc, { now = Date.now() } = {}) {
  const run = async () => {
    if (!notifier) notifier = notify.createNotifier(gc);
    const prev = await notify.loadState(gc, STATE_KEY);
    const cfg = configOf(await gc.settings.all());
    const { memo, events } = evaluate(prev, await store.listVehicles(gc), cfg, now);
    const owners = events.length ? await store.allOwners(gc) : new Map();
    for (const ev of events) {
      await notifier.send(toNotification(gc, ev, cfg, owners.get(ev.vehicleId) || []), { minGapMs: 10 * 60000 });
    }
    await notify.saveState(gc, STATE_KEY, memo, prev ? JSON.stringify(prev) : null);
    return events.length;
  };
  const p = chain.then(run, run);
  chain = p.catch((e) => { gc.log.warn('notification check failed', (e && e.code) || (e && e.message)); });
  return p;
}

module.exports = { evaluate, toNotification, configOf, check, reset, STATE_KEY, TEXTS };
