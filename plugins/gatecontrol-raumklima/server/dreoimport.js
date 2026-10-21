'use strict';

// 2.1.0 — Dreo devices appear by themselves. With a connected Dreo account the
// heaters and air conditioners of the account are added to the plugin (name
// and model from the Dreo app): right after the account was saved in the
// settings, and then hourly in the background (a device added later in the
// Dreo app shows up within the hour; the first run after an update catches
// accounts that were connected before). A device removed here stays removed
// (storage 'dreo_dismissed'; adding it again by hand lifts that). What the
// account holds is kept for the settings' status line (storage 'dreo_found':
// { at, devices: [{ sn, name, model, kind }] | null, error, checked } — checked since 2.1.1: the regions
// and lists asked).

const store = require('./store');
const dreo = require('./dreoservice');

const EVERY_MS = 3600000;
const DISMISSED = 'dreo_dismissed';
const FOUND = 'dreo_found';
const DISMISSED_MAX = 200;
const FOUND_MAX = 50;
const REV = 4;   // the look of an older version (another REV) is redone right after an update

const running = new WeakMap();   // gc → the run in progress (settings save and background never overlap)

async function dismissed(gc) {
  const v = await gc.storage.get(DISMISSED);
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
}

/** A Dreo device removed by an administrator: not added again by the import. */
async function dismiss(gc, sn) {
  const list = (await dismissed(gc)).filter((s) => s !== sn);
  list.push(sn);
  await gc.storage.set(DISMISSED, list.slice(-DISMISSED_MAX));
}

/** Added again by hand: the import may keep it. */
async function undismiss(gc, sn) {
  const list = await dismissed(gc);
  if (list.includes(sn)) await gc.storage.set(DISMISSED, list.filter((s) => s !== sn));
}

/** → { at, devices, error } of the last look into the account, or null. */
async function found(gc) {
  const v = await gc.storage.get(FOUND);
  return v && typeof v === 'object' && typeof v.at === 'number' ? v : null;
}

/** 2.1.1: which regions and lists were asked (for the status line): [{ region, lists: [{ list, count, error }], error }]. */
function checkedOf(diag) {
  const short = (p) => (p === 'open' ? 'open' : /family\/room/.test(p) ? 'rooms' : 'devices');
  return diag.slice(0, 4).map((r) => ({
    api: r.api === 'open' ? 'open' : 'app',
    region: r.region === 'NA' ? 'NA' : 'EU',
    error: r.error || null,
    detail: r.detail || null,
    lists: (r.lists || []).slice(0, 4).map((l) => ({ list: short(l.path), count: l.count == null ? null : l.count, error: l.error || null, detail: l.detail || null, shape: l.shape || null, refused: l.refused || null })),
  }));
}

/** The plugin's record of a device of the account (also used when adding by hand). */
function record(x, name) {
  return {
    name: name || x.name || x.model || 'Dreo',
    device_sn: 'dreo-' + x.sn,
    transport: 'cloud',
    cloud_appliance_id: x.sn,
    model: x.model || null,
    vendor: 'dreo',
    kind: x.kind,
  };
}

async function importNow(gc, now) {
  const cfg = await store.loadDreo(gc);
  if (!cfg.email || !cfg.passwordMd5 || !dreo.supported(gc)) return { added: [] };
  let list;
  const diag = [];
  try {
    list = await dreo.listCloudDevices(gc, diag);
  } catch (e) {
    await gc.storage.set(FOUND, { rev: REV, at: now, devices: null, error: e.code || 'ERROR', checked: checkedOf(diag) });
    throw e;
  }
  await gc.storage.set(FOUND, {
    rev: REV, at: now, error: null, checked: checkedOf(diag),
    devices: list.slice(0, FOUND_MAX).map((x) => ({ sn: x.sn, name: x.name, model: x.model, kind: x.kind })),
  });
  // 2.2.1: one log line per source asked (a line holds 1000 characters): what came back, its shape, errors
  if (!list.length) for (const r of checkedOf(diag)) gc.log.info('dreo account without devices', JSON.stringify(r));
  const skip = new Set(await dismissed(gc));
  const have = new Set((await store.listDevices(gc)).map((d) => d.device_sn));
  const added = [];
  for (const x of list) {
    if (!x.kind || skip.has(x.sn) || have.has('dreo-' + x.sn)) continue;
    added.push(await store.createDevice(gc, record(x)));
    have.add('dreo-' + x.sn);
  }
  if (added.length) gc.log.info('dreo devices added from the account', added.length);
  return { added };
}

/** Look into the account now (after saving the settings) → { added }; a failure throws. */
function run(gc, now = Date.now()) {
  const cur = running.get(gc);
  if (cur) return cur;
  const p = importNow(gc, now).finally(() => running.delete(gc));
  running.set(gc, p);
  return p;
}

/** Background: at most hourly; failures are kept for the status line, never thrown. */
async function maybe(gc, now = Date.now()) {
  const cfg = await store.loadDreo(gc);
  if (!cfg.email || !cfg.passwordMd5 || !dreo.supported(gc)) return;
  const last = await found(gc);
  // a look of an older version is redone at once (REV: 2.2.1 searches every key and logs shapes)
  if (last && last.rev === REV && now - last.at < EVERY_MS) return;
  try {
    await run(gc, now);
  } catch (e) {
    gc.log.debug('dreo import failed', e.code || e.message);
  }
}

/** The account was removed from the settings: forget what it held. */
async function clear(gc) {
  await gc.storage.delete(FOUND);
}

module.exports = { run, maybe, dismiss, undismiss, found, record, clear, EVERY_MS };
