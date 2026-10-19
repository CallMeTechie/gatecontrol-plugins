'use strict';

// Device notifications (plugin.json notifyTopics) from the background run —
// the LAN poll of Midea devices and the live connection of Dreo devices, no
// extra requests to the devices. Midea cloud devices are not polled around
// the clock (as before), so they do not notify. After every poll the devices' state is compared with the last
// seen state (kept in gc.storage, so a restart neither repeats nor loses
// anything):
//
//   device_unreachable  no answer for 10 minutes; "reachable again" replaces it
//   filter_clean        the device asks for a filter cleaning (once until it is reset)
//   error_code          the device reports a malfunction (priority high);
//                       "resolved" replaces it once it is gone
//
// A device seen for the first time (also: the very first run) only records
// its state: nothing that was already the case is announced.

const store = require('./store');
const notify = require('./notify');

const STATE_KEY = 'notify.state';
const OFFLINE_MIN = 10;

const TEXTS = {
  de: {
    'down.title': 'Gerät nicht erreichbar',
    'down.body': '{{name}} antwortet seit {{min}} Minuten nicht',
    'up.title': 'Gerät wieder erreichbar',
    'up.body': '{{name}} antwortet wieder',
    'filter.title': 'Filter reinigen',
    'filter.body': '{{name}}: Der Filter sollte gereinigt werden',
    'error.title': 'Störung am Klimagerät',
    'error.body': '{{name}} meldet eine Störung',
    'error.code': 'Code {{code}}',
    'error.clear.title': 'Störung behoben',
    'error.clear.body': '{{name}} meldet keine Störung mehr',
    'fact.indoor': 'Innen',
    'fact.mode': 'Modus',
    'fact.code': 'Fehlercode',
  },
  en: {
    'down.title': 'Device unreachable',
    'down.body': '{{name}} has not answered for {{min}} minutes',
    'up.title': 'Device reachable again',
    'up.body': '{{name}} answers again',
    'filter.title': 'Clean the filter',
    'filter.body': '{{name}}: the filter should be cleaned',
    'error.title': 'Air conditioner malfunction',
    'error.body': '{{name}} reports a malfunction',
    'error.code': 'code {{code}}',
    'error.clear.title': 'Malfunction resolved',
    'error.clear.body': '{{name}} no longer reports a malfunction',
    'fact.indoor': 'Indoor',
    'fact.mode': 'Mode',
    'fact.code': 'Error code',
  },
};

function configOf(settings) {
  return { offlineMin: OFFLINE_MIN, lang: notify.langOf(settings) };
}

/**
 * Pure transition logic.
 * @param {object|null} prevMemo  last stored state (null = first run)
 * @param {Array<{ device: { id, name }, online: boolean, state: object|null }>} observations  of the LAN poll
 * @param {{ offlineMin }} cfg
 * @param {number} now  ms
 * @returns {{ memo, events: Array<{ topic, kind, device, state?, minutes? }> }}
 */
function evaluate(prevMemo, observations, cfg, now) {
  const prevDevices = (prevMemo && prevMemo.devices) || {};
  const memo = { v: 1, devices: { ...prevDevices } }; // devices not polled this time keep what was known
  const events = [];
  for (const o of observations || []) {
    if (!o || !o.device) continue;
    const dev = o.device;
    const prev = prevMemo ? prevDevices[dev.id] || null : null;
    // seen: the device's state was read at least once (a device first met offline has no "before" yet)
    const cur = { offline: null, offlineSince: null, seen: !!(prev && prev.seen), filter: prev ? prev.filter || null : null, error: prev ? prev.error || null : null };

    // device_unreachable: offline = 'pending' | 'announced' | 'muted' (already offline at the first sighting)
    if (!o.online) {
      const was = !!(prev && prev.offlineSince != null);
      cur.offlineSince = was ? prev.offlineSince : now;
      cur.offline = was ? prev.offline : (prev ? 'pending' : 'muted');
      if (cur.offline === 'pending' && now - cur.offlineSince >= cfg.offlineMin * 60000) {
        events.push({ topic: 'device_unreachable', kind: 'down', device: dev, minutes: Math.round((now - cur.offlineSince) / 60000) });
        cur.offline = 'announced';
      }
      memo.devices[dev.id] = cur;
      continue;
    }
    if (prev && prev.offline === 'announced') events.push({ topic: 'device_unreachable', kind: 'up', device: dev });
    const s = o.state || {};
    const known = cur.seen; // false: first state of this device — only recorded
    cur.seen = true;

    // filter_clean: null | 'announced' | 'muted'
    if (s.filterAlert === true) {
      if (!known) cur.filter = 'muted';
      else if (!prev.filter) { events.push({ topic: 'filter_clean', kind: 'filter', device: dev, state: s }); cur.filter = 'announced'; }
    } else if (s.filterAlert === false) cur.filter = null;

    // error_code: null | 'announced' | 'muted'
    if (s.applianceError === true) {
      if (!known) cur.error = 'muted';
      else if (!prev.error) { events.push({ topic: 'error_code', kind: 'error', device: dev, state: s }); cur.error = 'announced'; }
    } else if (s.applianceError === false) {
      if (known && prev.error === 'announced') events.push({ topic: 'error_code', kind: 'clear', device: dev, state: s });
      cur.error = null;
    }

    memo.devices[dev.id] = cur;
  }
  return { memo, events };
}

/** Event → gc.notify payload. `owners` = user ids the device is assigned to (empty: the topic's rule decides). */
function toNotification(gc, ev, cfg, owners) {
  const lang = cfg.lang;
  const tx = (k, p) => notify.fmt(TEXTS, lang, k, p);
  const name = ev.device.name || `#${ev.device.id}`;
  const s = ev.state || {};
  const facts = [];
  if (typeof s.indoorTemp === 'number') facts.push({ label: tx('fact.indoor'), value: `${notify.num(s.indoorTemp, lang, 1)} °C` });
  const base = { ...notify.openAction(gc, lang), device_id: ev.device.id };
  const users = owners && owners.length ? owners : null;
  if (ev.topic === 'device_unreachable') {
    const collapseKey = `device:${ev.device.id}`;
    if (ev.kind === 'up') return { topic: ev.topic, title: tx('up.title'), body: tx('up.body', { name }), priority: 'info', collapseKey, ttl: 12 * 3600, users, data: base };
    return { topic: ev.topic, title: tx('down.title'), body: tx('down.body', { name, min: notify.num(ev.minutes, lang) }), priority: 'normal', collapseKey, ttl: 24 * 3600, users, data: base };
  }
  if (ev.topic === 'filter_clean') {
    return { topic: ev.topic, title: tx('filter.title'), body: tx('filter.body', { name }), priority: 'info', collapseKey: `filter:${ev.device.id}`, ttl: 7 * 86400, users, data: { ...base, facts } };
  }
  const collapseKey = `error:${ev.device.id}`;
  if (ev.kind === 'clear') return { topic: ev.topic, title: tx('error.clear.title'), body: tx('error.clear.body', { name }), priority: 'info', collapseKey, ttl: 12 * 3600, users, data: { ...base, facts } };
  const code = Number(s.errorCode) || 0;
  if (code) facts.unshift({ label: tx('fact.code'), value: String(code) });
  return {
    topic: ev.topic, title: tx('error.title'), body: tx('error.body', { name }) + (code ? ` (${tx('error.code', { code })})` : ''),
    priority: 'high', collapseKey, ttl: 24 * 3600, users, data: { ...base, error_code: code || null, facts },
  };
}

// ─── Glue (one check at a time) ─────────────────

let notifier = null;
let chain = Promise.resolve();

function reset() { notifier = null; }

/** Compare the poll's observations with the last seen state and send what changed. */
function check(gc, observations, { now = Date.now() } = {}) {
  const run = async () => {
    if (!notifier) notifier = notify.createNotifier(gc);
    const prev = await notify.loadState(gc, STATE_KEY);
    const cfg = configOf(await gc.settings.all());
    const { memo, events } = evaluate(prev, observations, cfg, now);
    const known = new Set((await store.listDevices(gc)).map((d) => String(d.id)));
    for (const id of Object.keys(memo.devices)) if (!known.has(id)) delete memo.devices[id]; // removed devices
    const owners = events.length ? await store.allOwners(gc) : new Map();
    for (const ev of events) await notifier.send(toNotification(gc, ev, cfg, owners.get(ev.device.id) || []), { minGapMs: 0 });
    await notify.saveState(gc, STATE_KEY, memo, prev ? JSON.stringify(prev) : null);
    return events.length;
  };
  const p = chain.then(run, run);
  chain = p.catch((e) => { gc.log.warn('notification check failed', (e && e.code) || (e && e.message)); });
  return p;
}

module.exports = { evaluate, toNotification, configOf, check, reset, STATE_KEY, TEXTS, OFFLINE_MIN };
