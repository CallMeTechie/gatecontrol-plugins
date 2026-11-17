'use strict';

// "Verbinden" in the portal tab and on the admin page: the plugin decides who
// may connect where, GateControl builds the session (gc.remote.session → a
// single-use ticket for the session page /remote/session/<ref>, opened by the
// frame with GC.openSession(ref)). Also wake-on-LAN and the device checks.
//
// 1.2 (gc.remote version 3): an SSH device with ssh_engine "term" opens GateControl's
// own terminal (engine term) — in the browser on the session page, in the apps natively
// (the app turns the ref into a WebSocket token at GateControl). tmux keeps the session
// on the device; the recording follows the device and the person (rights.policyFor):
// "optional" only when the person asks for it, "always" only with the hint before the
// start (the session page shows it; an app must confirm it: record: true).

const devices = require('./devices');
const rights = require('./rights');
const { TMUX_RE } = require('./devices');
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

/** Checks before any session of a device, in the order of the former browser sessions (an app's terminal needs no browser switch). */
async function admit(gc, user, d, access, { admin = false, via = 'browser', granted = false } = {}) {
  if (!d.enabled) throw fail('disabled');
  // granted (1.6): the person at the Linux device allowed exactly this request (code redeemed, request answered)
  if (!admin && !granted && !(await rights.mayUse(gc, user, d, access))) throw fail('no_right');
  if (!d.config.browser_enabled && via !== 'app') throw fail('no_browser');
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

/** recordings.available() of GateControl (version 3), else none. */
async function recordingsAvailable(gc) {
  if (!gc.remote || !(gc.remote.version >= 3)) return { available: false, reason: 'not_yet', engines: { term: false, guac: false } };
  try { return (await gc.remote.recordings.available()) || { available: false, engines: {} }; } catch { return { available: false, reason: 'error', engines: {} }; }
}

/**
 * Whether this session is recorded: the policy of device and person, what GateControl can record, what the caller asked.
 * → true | false (throws recording_required / recording_unavailable / invalid)
 */
async function decideRecording(gc, user, d, engine, { record, via, policy }) {
  const p = policy || await rights.policyFor(gc, user, d);
  if (record != null && typeof record !== 'boolean') throw fail('invalid', { field: 'record' });
  if (p === 'off') {
    if (record === true) throw fail('invalid', { field: 'record' });
    return false;
  }
  const want = p === 'always' ? true : record === true;
  // "immer": an app must have shown the hint and say so (the session page of GateControl shows it itself)
  if (p === 'always' && via === 'app' && record !== true) throw fail('recording_required');
  if (!want) return false;
  const a = await recordingsAvailable(gc);
  if (!a.available || !(a.engines && a.engines[engine])) throw fail('recording_unavailable', { reason: a.reason || (engine === 'guac' ? 'guacd_no_drive' : null) });
  return true;
}

/** tmux of a terminal session: { attach | create } of the caller (checked), else the device's own session; null without tmux. */
function tmuxFor(d, want) {
  const own = devices.tmuxOf(d);
  if (want == null) return own ? { create: own } : null;
  if (!own) throw fail('invalid', { field: 'tmux' });
  if (typeof want !== 'object' || Array.isArray(want)) throw fail('invalid', { field: 'tmux' });
  const k = Object.keys(want);
  if (k.length !== 1 || (k[0] !== 'attach' && k[0] !== 'create') || typeof want[k[0]] !== 'string' || !TMUX_RE.test(want[k[0]])) throw fail('invalid', { field: 'tmux' });
  return { [k[0]]: want[k[0]] };
}

/**
 * A ticket for the person → { ref, expiresAt, protocol, mode, engine, recording, tmux, device }
 * o.via: browser | app; o.tmux / o.record from the caller; o.engine 'term' lets an administrator try the terminal on a
 * device that still uses Guacamole (the test before switching it).
 */
async function open(gc, user, deviceId, cfg, { admin = false, mode = 'control', via = 'browser', tmux, record, engine: forced, granted = false } = {}) {
  if (!gc.remote) throw fail('offline');
  const d = await devices.need(gc, deviceId);
  const access = (await devices.accessLists(gc)).get(d.id) || devices.emptyAccess();
  let engine = devices.engineOf(d, gc) || 'guac';
  if (forced === 'term' && admin && d.protocol === 'ssh' && gc.remote.version >= 3) engine = 'term';
  if (via === 'app' && engine !== 'term') throw fail('invalid', { field: 'via' });
  await admit(gc, user, d, access, { admin, via, granted });
  await limits(gc, user, d, cfg || {});
  const term = engine === 'term';
  if (term && !d.credential) throw fail('credential_required');
  const t2 = term ? tmuxFor(engine === devices.engineOf(d, gc) ? d : { ...d, config: { ...d.config, ssh_engine: 'term' } }, tmux) : null;
  if (!term && tmux != null) throw fail('invalid', { field: 'tmux' });
  const rec = gc.remote.version >= 3 ? await decideRecording(gc, user, d, term ? 'term' : 'guac', { record, via }) : false;
  const options = optionsOf(d);
  if (t2) options.tmux = t2;
  try {
    const t = await gc.remote.session({
      user: user.id, target: devices.targetOf(d), protocol: d.protocol, mode: mode === 'view' ? 'view' : 'control',
      ...(d.credential ? { credential: d.credential } : {}), options, ttlS: 120,
      ...(gc.remote.version >= 3 ? { engine, record: rec } : {}),
    });
    return { ref: t.ref, expiresAt: t.expiresAt, protocol: t.protocol, mode: t.mode, engine, recording: rec, tmux: t2, device: { id: d.id, name: d.name } };
  } catch (e) { throw fromHost(e); }
}

/** 1.8: GateControl can list the windows and close sessions and windows (gc.remote version 9). */
const tmuxV9 = (gc) => !!(gc.remote && gc.remote.version >= 9 && gc.remote.tmux && typeof gc.remote.tmux.kill === 'function');

/** The device of a tmux call: enabled, the right (administrators always), GateControl's terminal. */
async function tmuxDevice(gc, user, deviceId, admin) {
  if (!gc.remote || !(gc.remote.version >= 3)) throw fail('offline');
  const d = await devices.need(gc, deviceId);
  const access = (await devices.accessLists(gc)).get(d.id) || devices.emptyAccess();
  if (!d.enabled) throw fail('disabled');
  if (!admin && !(await rights.mayUse(gc, user, d, access))) throw fail('no_right');
  if (devices.engineOf(d, gc) !== 'term') throw fail('invalid', { field: 'ssh_engine' });
  return d;
}

/** One session of gc.remote.tmux.list for the pages and apps (1.8: id and windows with { windows: true }). */
function tmuxView(s) {
  const v = { ...s };
  if (Array.isArray(s.windows)) {
    v.windowList = s.windows.slice(0, 100).map((w) => ({ id: w.id, index: w.index, name: w.name == null ? null : String(w.name).slice(0, 100), active: !!w.active,
      panes: Number.isInteger(w.panes) ? w.panes : null, command: w.command == null ? null : String(w.command).slice(0, 100) }));
    v.windows = Number.isInteger(s.windowCount) ? s.windowCount : v.windowList.length;
    delete v.windowCount;
  }
  return v;
}

/**
 * GET devices/<id>/tmux — the tmux sessions of an SSH device in the terminal → { sessions, tmux, hostKey: 'pinned' | 'unpinned', kill }.
 * 1.8: windows → each session with `id` ('$3') and `windowList` [{ id: '@7', index, name, active, panes, command }] (`windows`
 * stays the number); kill: closing sessions and windows is possible (gc.remote version 9).
 */
async function tmuxSessions(gc, user, deviceId, { admin = false, windows = false } = {}) {
  const d = await tmuxDevice(gc, user, deviceId, admin);
  const own = devices.tmuxOf(d);
  const kill = tmuxV9(gc);
  if (!own) return { sessions: [], tmux: null, hostKey: null, kill: false };
  if (!d.credential) throw fail('credential_required');
  try {
    const list = (await gc.remote.tmux.list(devices.targetOf(d), { credential: d.credential, ...(kill && windows ? { windows: true } : {}) })) || [];
    return { sessions: list.slice(0, 200).map(tmuxView), tmux: own, hostKey: 'pinned', kill };
  } catch (e) {
    // the first connection pins the host key in the terminal; until then there is nothing to list
    if (e && e.code === 'ERR_REMOTE_HOST_KEY_UNPINNED') return { sessions: [], tmux: own, hostKey: 'unpinned', kill: false };
    throw fromHost(e);
  }
}

const SESSION_ID_RE = /^\$\d{1,6}$/;
const WINDOW_ID_RE = /^@\d{1,6}$/;

/** { id, name, created } of a caller, checked (the name and the time only compare: GateControl closes by the number). */
function sessionRef(x, field) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !SESSION_ID_RE.test(x.id)) throw fail('invalid', { field });
  if (x.name != null && (typeof x.name !== 'string' || x.name.length > 256)) throw fail('invalid', { field });
  if (x.created != null && typeof x.created !== 'string' && typeof x.created !== 'number') throw fail('invalid', { field });
  return { id: x.id, ...(x.name != null ? { name: x.name } : {}), ...(x.created != null ? { created: x.created } : {}) };
}

async function killOne(gc, user, d, ref, win, current, admin, now) {
  const log = require('./log');
  const s = current.find((x) => x.id === ref.id) || null;
  let r;
  try {
    r = await gc.remote.tmux.kill(devices.targetOf(d), { credential: d.credential, session: ref, ...(win ? { window: win } : {}) });
  } catch (e) { throw fromHost(e); }
  const w = win && s && Array.isArray(s.windows) ? s.windows.find((x) => x.id === win.id) : null;
  await log.write(gc, 'remote_tmux_killed', { device: d, userId: user.id, details: { session: s ? String(s.name).slice(0, 64) : ref.name || ref.id, window: win ? (w ? w.index + ':' + String(w.name || '').slice(0, 40) : win.id) : null,
    attached: !!(s && s.attached), admin } }, now);
  return r && typeof r.killed === 'string' ? r.killed : (win ? 'window' : 'session');
}

/**
 * POST devices/<id>/tmux/kill { session: { id, name, created }, window?: { id, index } } → { killed: 'session' | 'window', sessions, … }
 * — the same right as listing; GateControl lists again and checks number, name and time before it closes by number.
 */
async function tmuxKill(gc, user, deviceId, body, { admin = false } = {}, now = Date.now()) {
  if (!tmuxV9(gc)) throw fail('offline');
  const d = await tmuxDevice(gc, user, deviceId, admin);
  if (!devices.tmuxOf(d)) throw fail('invalid', { field: 'tmux' });
  if (!d.credential) throw fail('credential_required');
  const b = body && typeof body === 'object' ? body : {};
  const ref = sessionRef(b.session, 'session');
  let win = null;
  if (b.window != null) {
    if (typeof b.window !== 'object' || typeof b.window.id !== 'string' || !WINDOW_ID_RE.test(b.window.id)) throw fail('invalid', { field: 'window' });
    win = { id: b.window.id, ...(Number.isInteger(b.window.index) ? { index: b.window.index } : {}) };
  }
  let current = [];
  try { current = (await gc.remote.tmux.list(devices.targetOf(d), { credential: d.credential, windows: true })) || []; } catch (e) { throw fromHost(e); }
  const killed = await killOne(gc, user, d, ref, win, current, admin, now);
  return { killed, ...(await tmuxSessions(gc, user, d.id, { admin, windows: true })) };
}

/**
 * POST devices/<id>/tmux/kill-detached { sessions: [{ id, name, created }] } → { killed: [ids], skipped: [{ id, reason }], sessions, … }
 * — only sessions nobody is attached to now (checked again here; an attached one is skipped, never closed).
 */
async function tmuxKillDetached(gc, user, deviceId, body, { admin = false } = {}, now = Date.now()) {
  if (!tmuxV9(gc)) throw fail('offline');
  const d = await tmuxDevice(gc, user, deviceId, admin);
  if (!devices.tmuxOf(d)) throw fail('invalid', { field: 'tmux' });
  if (!d.credential) throw fail('credential_required');
  const b = body && typeof body === 'object' ? body : {};
  if (!Array.isArray(b.sessions) || !b.sessions.length || b.sessions.length > 50) throw fail('invalid', { field: 'sessions' });
  const refs = b.sessions.map((x) => sessionRef(x, 'sessions'));
  let current = [];
  try { current = (await gc.remote.tmux.list(devices.targetOf(d), { credential: d.credential, windows: true })) || []; } catch (e) { throw fromHost(e); }
  const killed = [];
  const skipped = [];
  for (const ref of refs) {
    const s = current.find((x) => x.id === ref.id);
    if (!s) { skipped.push({ id: ref.id, reason: 'tmux_gone' }); continue; }
    if (s.attached) { skipped.push({ id: ref.id, reason: 'attached' }); continue; }
    try {
      await killOne(gc, user, d, ref, null, current, admin, now);
      killed.push(ref.id);
    } catch (e) {
      if (e && (e.code === 'tmux_gone' || e.code === 'tmux_changed')) { skipped.push({ id: ref.id, reason: e.code }); continue; }
      throw e;
    }
  }
  return { killed, skipped, ...(await tmuxSessions(gc, user, d.id, { admin, windows: true })) };
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

module.exports = { optionsOf, admit, open, wake, probe, probeAll, tmuxSessions, tmuxKill, tmuxKillDetached, tmuxV9, decideRecording, recordingsAvailable, tmuxFor };
