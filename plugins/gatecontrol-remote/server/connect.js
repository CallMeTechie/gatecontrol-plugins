'use strict';

// "Verbinden" in the portal tab and on the admin page: the plugin decides who
// may connect where, GateControl builds the session (gc.remote.session → a
// single-use ticket for the session page /remote/session/<ref>, opened by the
// frame with GC.openSession(ref)). Also wake-on-LAN and the device checks.

const devices = require('./devices');
const rights = require('./rights');
const maintenance = require('./maintenance');
const { fail, fromHost } = require('./util');

/** The guacd options of a device (the fields of the old route with the same meaning). */
function optionsOf(d) {
  const c = d.config;
  const o = { browser_clipboard: !!c.browser_clipboard };
  if (d.protocol === 'rdp') {
    Object.assign(o, {
      color_depth: c.color_depth === 15 ? 16 : (c.color_depth || null),
      nla_enabled: !!c.nla_enabled,
      network_profile: c.network_profile || null,
      disable_wallpaper: !!c.disable_wallpaper,
      disable_themes: !!c.disable_themes,
      disable_animations: !!c.disable_animations,
      redirect_printers: !!c.redirect_printers,
      rdp_disable_audio: !!c.rdp_disable_audio,
      resolution_mode: c.resolution_mode || null,
      resolution_width: c.resolution_mode === 'fixed' ? c.resolution_width : null,
      resolution_height: c.resolution_mode === 'fixed' ? c.resolution_height : null,
      domain: c.domain || null,
    });
  } else if (d.protocol === 'vnc') {
    o.color_depth = c.color_depth === 15 ? 16 : (c.color_depth || null);
  }
  for (const k of Object.keys(o)) if (o[k] == null) delete o[k];
  return o;
}

/** Checks before any session of a device, in the order of the former browser sessions. */
async function admit(gc, user, d, access, { admin = false } = {}) {
  if (!d.enabled) throw fail('disabled');
  if (!admin && !(await rights.mayUse(gc, user, d, access))) throw fail('no_right');
  if (!d.config.browser_enabled) throw fail('no_browser');
  if (d.credentialUnreadable) throw fail('credential_unreadable');
  if (maintenance.inWindow(d.config)) throw fail('maintenance', { schedule: d.config.maintenance_schedule });
}

async function limits(gc, user, d, cfg) {
  if (!cfg.maxPerUser && !cfg.maxPerDevice) return;
  let live = [];
  try { live = (await gc.remote.sessions({ active: true, limit: 500 })) || []; } catch { return; }
  if (cfg.maxPerUser && live.filter((s) => s.userId === user.id).length >= cfg.maxPerUser) throw fail('limit', { max: cfg.maxPerUser, per: 'user' });
  if (cfg.maxPerDevice && live.filter((s) => s.targetId === 'dev-' + d.id).length >= cfg.maxPerDevice) throw fail('limit', { max: cfg.maxPerDevice, per: 'device' });
}

/** A ticket for the person → { ref, expiresAt, protocol, mode } */
async function open(gc, user, deviceId, cfg, { admin = false, mode = 'control' } = {}) {
  if (!gc.remote) throw fail('offline');
  const d = await devices.need(gc, deviceId);
  const access = (await devices.accessLists(gc)).get(d.id) || devices.emptyAccess();
  await admit(gc, user, d, access, { admin });
  await limits(gc, user, d, cfg);
  try {
    const t = await gc.remote.session({
      user: user.id, target: devices.targetOf(d), protocol: d.protocol, mode: mode === 'view' ? 'view' : 'control',
      ...(d.credential ? { credential: d.credential } : {}), options: optionsOf(d), ttlS: 120,
    });
    return { ref: t.ref, expiresAt: t.expiresAt, protocol: t.protocol, mode: t.mode, device: { id: d.id, name: d.name } };
  } catch (e) { throw fromHost(e); }
}

/** Wake-on-LAN for a person who may use the device (administrators always). */
async function wake(gc, user, deviceId, { admin = false } = {}) {
  const d = await devices.need(gc, deviceId);
  if (!d.config.wol_enabled || !d.config.wol_mac_address) throw fail('invalid', { field: 'wol' });
  if (!admin) {
    const access = (await devices.accessLists(gc)).get(d.id) || devices.emptyAccess();
    if (!(await rights.mayUse(gc, user, d, access))) throw fail('no_right');
  }
  try { return await gc.remote.wake(devices.targetOf(d)); } catch (e) { throw fromHost(e); }
}

/** One check of a device now → its status. */
async function probe(gc, d, now = Date.now()) {
  let s;
  try { s = await gc.remote.probe(devices.targetOf(d)); } catch (e) { s = { online: false, responseTime: null, error: (e && e.code) || 'error' }; }
  await devices.setStatus(gc, d.id, s, now);
  return { online: !!s.online, responseTime: s.responseTime == null ? null : s.responseTime, lastCheck: new Date(now).toISOString() };
}

/** The background check of every enabled device (health check on), a few at a time. */
async function probeAll(gc, now = Date.now()) {
  const list = (await devices.all(gc)).filter((d) => d.enabled && d.config.health_check_enabled);
  const changed = [];
  for (let i = 0; i < list.length; i += 4) {
    const part = list.slice(i, i + 4);
    const out = await Promise.all(part.map((d) => probe(gc, d, now)));
    part.forEach((d, j) => { if (d.status.online !== out[j].online) changed.push({ id: d.id, online: out[j].online }); });
  }
  return changed;
}

module.exports = { optionsOf, admit, open, wake, probe, probeAll };
