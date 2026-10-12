'use strict';

// gatecontrol-synology — "NAS (Synology)": status and control of Synology
// NAS in the home network through the DSM Web API (server/dsm.js), polled
// in the background, with notifications through GateControl's notification
// center. Administrators only: no portal tab, no portal sections.
//
//   admin API   (the plugin page)
//     GET    /status                  everything the page shows (never a secret)
//     GET    /nas/:id                 one NAS
//     POST   /nas                     add  { name, target_index, username, password, otp?, device_ref?, enabled? }
//     PUT    /nas/:id                 edit (fields left out keep their value; empty password = keep)
//     DELETE /nas/:id                 remove (logs out, deletes the stored account)
//     POST   /nas/test                "Verbindung testen" { id?, target_index, username?, password?, otp? }
//     POST   /nas/:id/refresh         poll now
//     POST   /nas/:id/power           { action: 'reboot'|'shutdown', confirm: true }
//     POST   /nas/:id/backups/:task/start   { confirm: true } — Hyper Backup "back up now"
//     PUT    /settings                the plugin settings (same as Settings → Plugins)
//
// Every request is refused unless it comes from an administrator of the
// admin interface (never a portal viewer, never another role). The DSM
// password, user name and device token are plugin secrets and never leave
// the plugin; the page gets a masked user name and flags only.

const crypto = require('node:crypto');
const ui = require('./ui');
const store = require('./store');
const config = require('./config');
const service = require('./service');
const alerts = require('./alerts');
const texts = require('./texts.json');

function t(lang, key, params) {
  const l = lang === 'en' ? 'en' : 'de';
  let s = (texts[l] && texts[l][key]) || texts.de[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{{${k}}}`).join(String(v));
  return s;
}

// error code → [HTTP status, text key]
const ERRORS = {
  INVALID: [400, 'error.invalid'],
  NAME_REQUIRED: [400, 'error.name_required'],
  TARGET_REQUIRED: [400, 'error.target_required'],
  ACCOUNT_REQUIRED: [400, 'error.account_required'],
  OTP_FORMAT: [400, 'error.otp_format'],
  CONFIRM_REQUIRED: [400, 'error.confirm_required'],
  SETTINGS_INVALID: [400, 'error.settings_invalid'],
  FORBIDDEN: [403, 'error.forbidden'],
  NOT_FOUND: [404, 'error.not_found'],
  NAS_DISABLED: [409, 'error.nas_disabled'],
};
// DSM and connection problems: 502 (the NAS answered so, not this request)
const DSM_CODES = [
  'UNREACHABLE', 'TIMEOUT', 'TLS_CERT', 'HTTPS_REDIRECT', 'HTTP_REDIRECT', 'HTTP_TO_HTTPS_PORT', 'HTTP_ERROR', 'NOT_DSM', 'TARGET_UNASSIGNED', 'TARGET_DENIED',
  'DSM_TOO_OLD', 'AUTH_FAILED', 'ACCOUNT_DISABLED', 'AUTH_DENIED', 'OTP_REQUIRED', 'OTP_INVALID', 'OTP_ENFORCED', 'IP_BLOCKED', 'PASSWORD_EXPIRED', 'NO_CREDENTIALS',
  'PERMISSION', 'SESSION_EXPIRED', 'DSM_BUSY', 'IP_MISMATCH', 'API_MISSING', 'DSM_ERROR',
];
for (const c of DSM_CODES) ERRORS[c] = [502, `dsm.${c}`];

const errorKey = (code) => (ERRORS[code] ? ERRORS[code][1] : 'dsm.INTERNAL');

function fail(code) { return Object.assign(new Error(code), { code }); }

function errorResponse(e, lang) {
  const known = e && ERRORS[e.code];
  const [status, key] = known || [500, 'error.internal'];
  return { status, json: { ok: false, code: known ? e.code : 'INTERNAL', error: t(lang, key) } };
}

const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** "admin" → "ad•••" (the page shows which account, never the whole name). */
function maskUser(u) {
  if (!u) return null;
  const s = String(u);
  return s.length <= 2 ? '•••' : `${s.slice(0, 2)}•••`;
}

async function targetsOf(gc) {
  try {
    const t0 = (await gc.net.targets()).find((x) => x.id === 'nas');
    return t0 ? t0.assigned.map((a) => ({ index: a.index, label: a.label })) : [];
  } catch { return []; }
}

// ─── Views (never a secret) ─────────────────────

function nasView(n, snap, cfg, targets, all, lang) {
  const tg = targets.find((x) => x.index === n.target_index);
  const data = snap ? snap.data : null;
  const user = all[store.secretKey(n.id, 'user')];
  return {
    id: n.id, name: n.name, enabled: n.enabled,
    target_index: n.target_index, target_label: tg ? tg.label : null, target_saved_label: n.target_label, target_missing: !tg,
    account: { user_hint: maskUser(user), has_user: !!user, has_password: !!all[store.secretKey(n.id, 'password')], has_device: !!all[store.secretKey(n.id, 'device')] },
    status: n.status, error: n.last_error ? { code: n.last_error, text: t(lang, errorKey(n.last_error)) } : null, error_count: n.error_count,
    last_attempt_at: n.last_attempt_at, last_success_at: n.last_success_at, next_poll_at: n.next_poll_at,
    power: n.power_state ? { state: n.power_state, at: n.power_at } : null,
    fetched_at: snap ? snap.fetched_at : null, data, issues: alerts.issuesOf(data, cfg),
  };
}

async function settingsAll(gc) {
  try { return (await gc.settings.all()) || {}; } catch { return {}; }
}

// ─── Fields from a request ──────────────────────

const OTP_RE = /^[A-Za-z0-9]{6,12}$/;

function otpOf(body) {
  if (body.otp == null || body.otp === '') return null;
  const s = typeof body.otp === 'string' ? body.otp.replace(/\s+/g, '') : '';
  if (!OTP_RE.test(s)) throw fail('OTP_FORMAT');
  return s;
}

function targetIndexOf(v, targets) {
  const idx = Number.isInteger(v) ? v : (typeof v === 'string' && /^\d{1,2}$/.test(v) ? Number(v) : null);
  if (idx == null || !targets.some((x) => x.index === idx)) throw fail('TARGET_REQUIRED');
  return idx;
}

/** Fields of a NAS (create: all required; update: only given ones) + its secrets. */
function nasFields(body, existing, targets) {
  const out = {};
  const secrets = {};
  if (!existing || body.name !== undefined) {
    out.name = str(body.name, 60);
    if (!out.name) throw fail('NAME_REQUIRED');
  }
  if (!existing || body.target_index !== undefined) {
    out.target_index = targetIndexOf(body.target_index, targets);
    out.target_label = (targets.find((x) => x.index === out.target_index) || {}).label || null;
  }
  if (body.username !== undefined && body.username !== '') {
    const u = typeof body.username === 'string' ? body.username.trim() : '';
    if (!u || u.length > 200 || /[\0-\x1f\x7f]/.test(u)) throw fail('ACCOUNT_REQUIRED');
    secrets.user = u;
  }
  if (typeof body.password === 'string' && body.password !== '') {
    if (body.password.length > 500 || /[\0\r\n]/.test(body.password)) throw fail('INVALID');
    secrets.password = body.password;
  } else if (body.password != null && typeof body.password !== 'string') throw fail('INVALID');
  if (!existing && (!secrets.user || !secrets.password)) throw fail('ACCOUNT_REQUIRED');
  if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean') throw fail('INVALID'); out.enabled = body.enabled; }
  return { fields: out, secrets };
}

// Device tokens obtained by "Verbindung testen" with a one-time code, until
// the dialog is saved (the token itself never goes to the browser).
const pendingDevices = new Map(); // ref → { did, target_index, account, expires }
const PENDING_MS = 15 * 60000;

function keepPending(did, targetIndex, account) {
  const now = Date.now();
  for (const [k, v] of pendingDevices) if (v.expires < now) pendingDevices.delete(k);
  const ref = crypto.randomBytes(16).toString('hex');
  pendingDevices.set(ref, { did, target_index: targetIndex, account, expires: now + PENDING_MS });
  return ref;
}

function takePending(ref, targetIndex, account) {
  if (typeof ref !== 'string' || !pendingDevices.has(ref)) return null;
  const p = pendingDevices.get(ref);
  pendingDevices.delete(ref);
  return p.expires >= Date.now() && p.target_index === targetIndex && p.account === account ? p.did : null;
}

function observation(n, r) {
  return {
    nas: { id: n.id, name: n.name }, reachable: r.reachable, failures: r.failures || 0,
    power: n.power_state ? { state: n.power_state, at: n.power_at } : null, snap: r.snapshot || null, lastSeen: r.lastSeen || null,
  };
}

/** Poll now and feed the notification state (a manual poll counts like a background one). */
async function pollNow(gc, n, cfg, opts) {
  const r = await service.poll(gc, n, cfg, { manual: true, ...opts });
  const list = await store.listNas(gc);
  await alerts.check(gc, [observation(n, r)], cfg, { known: new Set(list.map((x) => x.id)) }).catch(() => {});
  return r;
}

function resultView(r, lang) {
  if (!r) return null;
  return r.ok ? { ok: true } : { ok: false, code: r.code, error: t(lang, errorKey(r.code)) };
}

// ─── Routes ─────────────────────────────────────

async function route(req, gc, seg, cfg, lang) {
  const m = req.method;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const [a, b, c, d, e] = seg;

  if (a === 'status' && seg.length === 1 && m === 'GET') {
    const targets = await targetsOf(gc);
    const list = await store.listNas(gc);
    const snaps = await store.allSnapshots(gc);
    const all = await settingsAll(gc);
    return {
      json: {
        ok: true, now: Date.now(), settings: config.view(cfg), targets,
        nas: list.map((n) => nasView(n, snaps.get(n.id), cfg, targets, all, lang)),
      },
    };
  }

  if (a === 'settings' && seg.length === 1 && m === 'PUT') {
    const values = {};
    for (const k of Object.keys(config.RANGES)) {
      if (body[k] === undefined) continue;
      const n = config.intIn(body[k], k);
      if (n == null) throw fail('SETTINGS_INVALID');
      values[k] = n;
    }
    if (body.notify_lang !== undefined) {
      if (body.notify_lang !== 'de' && body.notify_lang !== 'en') throw fail('SETTINGS_INVALID');
      values.notify_lang = body.notify_lang;
    }
    for (const [k, v] of Object.entries(values)) await gc.settings.set(k, v);
    return { json: { ok: true, settings: config.view(await config.load(gc)) } };
  }

  if (a !== 'nas') throw fail('NOT_FOUND');
  const targets = await targetsOf(gc);

  if (b === 'test' && seg.length === 2 && m === 'POST') {
    const targetIndex = targetIndexOf(body.target_index, targets);
    const otp = otpOf(body);
    const existing = posInt(body.id) ? await store.getNas(gc, posInt(body.id)) : null;
    if (body.id != null && !existing) throw fail('NOT_FOUND');
    const stored = existing ? await store.credentials(gc, existing.id) : { account: null, password: null, device: null };
    const account = typeof body.username === 'string' && body.username.trim() ? body.username.trim().slice(0, 200) : stored.account;
    const password = typeof body.password === 'string' && body.password ? body.password.slice(0, 500) : stored.password;
    if (!account || !password) throw fail('ACCOUNT_REQUIRED');
    const device = account === stored.account ? stored.device : null;
    const r = await service.test(gc, { targetIndex, account, password, device, otp });
    return { json: { ok: true, model: r.model, dsm: r.dsm, admin: r.admin, device_ref: r.did ? keepPending(r.did, targetIndex, account) : null } };
  }

  if (!b && m === 'POST') {
    const { fields, secrets } = nasFields(body, null, targets);
    const otp = otpOf(body);
    const n = await store.createNas(gc, fields);
    await store.setSecret(gc, n.id, 'user', secrets.user);
    await store.setSecret(gc, n.id, 'password', secrets.password);
    const did = takePending(body.device_ref, n.target_index, secrets.user);
    if (did) await store.setSecret(gc, n.id, 'device', did);
    gc.log.info('NAS added', n.id, `by ${req.user.name || req.user.id}`);
    const r = n.enabled ? await pollNow(gc, n, cfg, { otp }) : null;
    return { status: 201, json: { ok: true, nas: { id: n.id }, result: resultView(r, lang) } };
  }

  const id = posInt(b);
  if (!id) throw fail('NOT_FOUND');
  const n = await store.getNas(gc, id);
  if (!n) throw fail('NOT_FOUND');

  if (seg.length === 2 && m === 'GET') {
    return { json: { ok: true, nas: nasView(n, await store.getSnapshot(gc, id), cfg, targets, await settingsAll(gc), lang) } };
  }

  if (seg.length === 2 && m === 'PUT') {
    const { fields, secrets } = nasFields(body, n, targets);
    const otp = otpOf(body);
    const stored = await store.credentials(gc, id);
    const accountChanged = secrets.user !== undefined && secrets.user !== stored.account;
    if (secrets.user !== undefined) await store.setSecret(gc, id, 'user', secrets.user);
    if (secrets.password !== undefined) await store.setSecret(gc, id, 'password', secrets.password);
    if (accountChanged) await store.setSecret(gc, id, 'device', null); // the device token belongs to the old account
    const did = takePending(body.device_ref, fields.target_index !== undefined ? fields.target_index : n.target_index, secrets.user || stored.account);
    if (did) await store.setSecret(gc, id, 'device', did);
    if (accountChanged || secrets.password !== undefined || fields.target_index !== undefined || otp) await service.dropSession(gc, id, { logout: true });
    const updated = await store.updateNas(gc, id, { ...fields, next_poll_at: 0, error_count: 0, ...(n.status === 'auth' || n.status === 'otp' ? { status: 'new', last_error: null } : {}) });
    const r = updated.enabled ? await pollNow(gc, updated, cfg, { otp }) : null;
    return { json: { ok: true, nas: { id }, result: resultView(r, lang) } };
  }

  if (seg.length === 2 && m === 'DELETE') {
    await service.dropSession(gc, id, { logout: true }).catch(() => {});
    const ok = await store.deleteNas(gc, id);
    gc.log.info('NAS removed', id, `by ${req.user.name || req.user.id}`);
    return { json: { ok } };
  }

  if (seg.length === 3 && c === 'refresh' && m === 'POST') {
    if (!n.enabled) throw fail('NAS_DISABLED');
    const r = await pollNow(gc, n, cfg, { otp: otpOf(body) });
    return { json: { ok: true, result: resultView(r, lang) } };
  }

  if (seg.length === 3 && c === 'power' && m === 'POST') {
    const action = body.action;
    if (action !== 'reboot' && action !== 'shutdown') throw fail('INVALID');
    if (body.confirm !== true) throw fail('CONFIRM_REQUIRED');
    if (!n.enabled) throw fail('NAS_DISABLED');
    const who = str(req.user.name, 60) || `#${req.user.id}`;
    gc.log.warn(`NAS ${action} requested`, id, n.name, `by ${who}`);
    await service.power(gc, n, action);
    await alerts.sendPower(gc, n, action, who, cfg);
    return { json: { ok: true, power: { state: action } } };
  }

  if (seg.length === 5 && c === 'backups' && e === 'start' && m === 'POST') {
    const task = posInt(d) || (d === '0' ? 0 : null);
    if (task == null) throw fail('NOT_FOUND');
    if (body.confirm !== true) throw fail('CONFIRM_REQUIRED');
    if (!n.enabled) throw fail('NAS_DISABLED');
    const snap = await store.getSnapshot(gc, id);
    const known = snap && snap.data && Array.isArray(snap.data.backups) ? snap.data.backups.find((x) => x.id === task) : null;
    if (!known) throw fail('NOT_FOUND');
    gc.log.info('Hyper Backup task started', id, task, `by ${str(req.user.name, 60) || req.user.id}`);
    await service.startBackup(gc, n, task);
    return { json: { ok: true } };
  }

  throw fail('NOT_FOUND');
}

/** Only an administrator in the admin interface (never a portal viewer). */
function isAdmin(user) {
  return !!user && user.portal !== true && user.role === 'admin';
}

// ─── Module ─────────────────────────────────────

const state = { ticking: false };
const TICK_BUDGET_MS = 50000;

module.exports = {
  async start(gc) {
    alerts.reset();
    gc.log.info('synology started', gc.plugin.version);
  },

  async stop(gc) {
    await service.logoutAll(gc).catch(() => {});
  },

  async request(req, gc) {
    const lang = req.lang === 'en' ? 'en' : 'de';
    try {
      if (!isAdmin(req.user)) throw fail('FORBIDDEN');
      const seg = String(req.path || '/').split('/').filter(Boolean);
      if (!seg.length) throw fail('NOT_FOUND');
      const cfg = await config.load(gc);
      return await route(req, gc, seg, cfg, lang);
    } catch (e) {
      const code = e && e.code;
      if (!ERRORS[code]) gc.log.warn('request failed', req.method, String(req.path || '').split('/').slice(0, 3).join('/'), code || (e && e.message) || 'error');
      return errorResponse(e, lang);
    }
  },

  async render(view, gc) {
    return { html: ui.render(view, t, isAdmin(view && view.user) && view.view !== 'portal') };
  },

  /**
   * Background (every minute): the NAS whose poll is due, one after the
   * other — none started after 50 s, so the tick stays within the host's
   * limit; an overlapping run is skipped. Then the notifications.
   */
  async tick(gc) {
    if (state.ticking) return;
    state.ticking = true;
    try {
      const deadline = Date.now() + TICK_BUDGET_MS;
      const cfg = await config.load(gc);
      const list = await store.listNas(gc);
      const obs = [];
      for (const n of list) {
        if (!n.enabled || n.next_poll_at > Date.now()) continue;
        if (Date.now() > deadline) break;
        const r = await service.poll(gc, n, cfg);
        obs.push(observation(n, r));
      }
      if (obs.length) await alerts.check(gc, obs, cfg, { known: new Set(list.map((x) => x.id)) }).catch(() => {});
    } finally { state.ticking = false; }
  },

  _state: state,
  _pending: pendingDevices,
  _errors: ERRORS,
  _dsmCodes: DSM_CODES,
};

