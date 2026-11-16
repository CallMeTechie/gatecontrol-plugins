'use strict';

// The plugin's own settings (admin page "Einstellungen"), one JSON value under
// the plugin key 'remote.config'. GateControl's own limits (GC_GUAC_MAX_*)
// always hold as well; these can only be stricter.

const { fail } = require('./util');

const KEY = 'remote.config';
const DEFAULTS = Object.freeze({
  maxPerUser: 0,        // open browser sessions per person (0 = only GateControl's limit)
  maxPerDevice: 0,      // open browser sessions per device (0 = only GateControl's limit)
  historyDays: 365,     // the history is kept 30 … 3650 days
  checkMinutes: 5,      // how often the devices are checked (1 … 60 minutes)
  recordingDays: 30,    // 1.2: recordings are kept 1 … 3650 days (GateControl's own limit GC_REMOTE_REC_DAYS holds as well)
});
const RANGES = Object.freeze({ maxPerUser: [0, 20], maxPerDevice: [0, 20], historyDays: [30, 3650], checkMinutes: [1, 60], recordingDays: [1, 3650] });

function normalise(v) {
  const c = { ...DEFAULTS };
  if (v && typeof v === 'object') {
    for (const [k, [lo, hi]] of Object.entries(RANGES)) if (Number.isInteger(v[k]) && v[k] >= lo && v[k] <= hi) c[k] = v[k];
  }
  return c;
}

async function load(gc) {
  let v = null;
  try { v = await gc.settings.get(KEY); } catch { v = null; }
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  return normalise(v);
}

/** A change from the admin page: only known keys, each checked. */
async function save(gc, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail('invalid');
  const next = { ...(await load(gc)) };
  for (const [k, v] of Object.entries(patch)) {
    const r = RANGES[k];
    if (!r) throw fail('invalid', { field: k });
    if (!Number.isInteger(v) || v < r[0] || v > r[1]) throw fail('invalid', { field: k });
    next[k] = v;
  }
  await gc.settings.set(KEY, next);
  return next;
}

module.exports = { load, save, normalise, DEFAULTS, RANGES, KEY };
