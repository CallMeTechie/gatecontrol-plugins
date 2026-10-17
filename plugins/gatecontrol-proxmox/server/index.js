'use strict';

// gatecontrol-proxmox — Proxmox VE status and control as a GateControl plugin.
//
//   admin API   (the plugin page; administrators only — a portal viewer or a
//                non-admin is refused, the plugin has no portal part)
//     GET    /status                          everything the page shows (never a token secret)
//     GET    /targets                         assignments of the home target "pve"
//     POST   /hosts                           { name, target_index, token_id, token_secret }
//     POST   /hosts/test                      { host_id?, target_index, token_id, token_secret? } → version, cluster, nodes
//     PUT    /hosts/:id                       { name?, target_index?, token_id?, token_secret? ('' = keep), enabled? }
//     DELETE /hosts/:id
//     POST   /hosts/:id/refresh               poll now
//     PUT    /hosts/:id/guests/:vmid/watch    { watched }
//     POST   /hosts/:id/guests/:vmid/action   { action: start|shutdown|stop|reboot, confirm: true,
//                                               confirm_hard: true (stop only) }
//     GET    /actions/:id                     the action, its task checked once more while running
//
//   quick actions, widgets and the Start tile of the GateControl apps
//   (hooks quickActions / runQuickAction / portalTiles, server/quick.js) —
//   administrators only: per connection a refresh button with its widget,
//   per watched guest start/shut down (a toggle) and reboot; nothing for
//   anybody else, the portal itself shows nothing (portalVisible: only an
//   administrator's app, for the Start tile)
//
// Requests run with the requesting user's rights; control actions are
// written to the plugin log with the administrator's name and kept in the
// action list. The API token secret is stored with gc.settings.setSecret
// and never leaves the plugin (the page gets has_secret only).

const ui = require('./ui');
const store = require('./store');
const config = require('./config');
const poll = require('./poll');
const control = require('./control');
const alerts = require('./alerts');
const pve = require('./pve');
const quick = require('./quick');
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
  TOKEN_ID_INVALID: [400, 'error.token_id_invalid'],
  SECRET_INVALID: [400, 'error.secret_invalid'],
  ACTION_INVALID: [400, 'error.action_invalid'],
  CONFIRM_REQUIRED: [400, 'error.confirm_required'],
  GUEST_NOT_FOUND: [404, 'error.guest_not_found'],
  GUEST_TEMPLATE: [409, 'error.guest_template'],
  GUEST_STATE: [409, 'error.guest_state'],
  HOST_DISABLED: [409, 'error.host_disabled'],
  PVE_NO_TARGET: [400, 'error.PVE_NO_TARGET'],
  PVE_TARGET_DENIED: [400, 'error.PVE_TARGET_DENIED'],
  PVE_NO_SECRET: [400, 'error.PVE_NO_SECRET'],
  PVE_UNREACHABLE: [502, 'error.PVE_UNREACHABLE'],
  PVE_TIMEOUT: [504, 'error.PVE_TIMEOUT'],
  PVE_TLS: [502, 'error.PVE_TLS'],
  PVE_HTTPS_REQUIRED: [502, 'error.PVE_HTTPS_REQUIRED'],
  PVE_AUTH: [502, 'error.PVE_AUTH'],
  PVE_FORBIDDEN: [502, 'error.PVE_FORBIDDEN'],
  PVE_NOT_FOUND: [502, 'error.PVE_NOT_FOUND'],
  PVE_BAD_REQUEST: [502, 'error.PVE_BAD_REQUEST'],
  PVE_NODE_DOWN: [502, 'error.PVE_NODE_DOWN'],
  PVE_GATEWAY: [502, 'error.PVE_GATEWAY'],
  PVE_SERVER: [502, 'error.PVE_SERVER'],
  PVE_HTTP: [502, 'error.PVE_HTTP'],
  PVE_BAD_RESPONSE: [502, 'error.PVE_BAD_RESPONSE'],
  FORBIDDEN: [403, 'error.forbidden'],
  NOT_FOUND: [404, 'error.not_found'],
};

// a poll from the page: shorter per-request timeouts, so it ends within the host's 30 s request limit
const INTERACTIVE_TIMEOUT_MS = 6000;

function fail(code) { return Object.assign(new Error(code), { code }); }

function errorResponse(e, lang) {
  const known = e && ERRORS[e.code];
  const [status, key] = known || [500, 'error.internal'];
  return { status, json: { ok: false, code: known ? e.code : 'INTERNAL', error: t(lang, key) } };
}

const errorText = (code, lang) => (code ? t(lang, ERRORS[code] ? ERRORS[code][1] : 'error.internal') : null);

const posInt = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

async function targetsOf(gc) {
  try {
    const t0 = (await gc.net.targets()).find((x) => x.id === pve.TARGET);
    return t0 ? t0.assigned.map((a) => ({ index: a.index, label: a.label })) : [];
  } catch { return []; }
}

// ─── Views ──────────────────────────────────────

function actionView(a, lang) {
  if (!a) return null;
  return {
    id: a.id, host_id: a.host_id, node: a.node, guest_type: a.guest_type, vmid: a.vmid, guest_name: a.guest_name, action: a.action,
    status: a.status, exitstatus: a.exitstatus, user_name: a.user_name, started_at: a.started_at, finished_at: a.finished_at,
    status_text: t(lang, 'action.status.' + a.status),
  };
}

async function hostView(gc, h, targets, lang) {
  const tg = h.target_index == null ? null : targets.find((x) => x.index === h.target_index);
  return {
    id: h.id, name: h.name, target_index: h.target_index, target_label: tg ? tg.label : null, token_id: h.token_id,
    has_secret: Boolean(await store.secretOf(gc, h.id)), enabled: h.enabled,
    status: h.status, last_error: h.last_error, error_text: errorText(h.last_error, lang), error_count: h.error_count,
    last_attempt_at: h.last_attempt_at, last_success_at: h.last_success_at, next_poll_at: h.next_poll_at,
    version: h.pve_version, cluster_name: h.cluster_name,
    watched: await store.watchedOf(gc, h.id),
    snapshot: await store.snapshotOf(gc, h.id),
  };
}

// ─── Hosts (admin) ──────────────────────────────

async function hostFields(gc, body, existing, targets) {
  const out = {};
  let secret;
  if (!existing || body.name !== undefined) { out.name = str(body.name, 60); if (!out.name) throw fail('NAME_REQUIRED'); }
  if (!existing || body.target_index !== undefined) {
    const idx = Number.isInteger(body.target_index) ? body.target_index : null;
    if (idx == null || !targets.some((x) => x.index === idx)) throw fail('TARGET_REQUIRED');
    out.target_index = idx;
  }
  if (!existing || body.token_id !== undefined) {
    const id = typeof body.token_id === 'string' ? body.token_id.trim() : '';
    if (!pve.validTokenId(id)) throw fail('TOKEN_ID_INVALID');
    out.token_id = id;
  }
  const s = typeof body.token_secret === 'string' ? body.token_secret.trim() : '';
  if (s) {
    if (!pve.validSecret(s)) throw fail('SECRET_INVALID');
    secret = s;
  } else if (!existing) throw fail('SECRET_INVALID');
  if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean') throw fail('INVALID'); out.enabled = body.enabled; }
  return { fields: out, secret };
}

// ─── Routes ─────────────────────────────────────

async function adminRoute(req, gc, seg, lang) {
  const m = req.method;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const [a, b, c, d, e] = seg;

  if (a === 'status' && seg.length === 1 && m === 'GET') {
    const cfg = await config.load(gc);
    const targets = await targetsOf(gc);
    const hosts = [];
    for (const h of await store.listHosts(gc)) hosts.push(await hostView(gc, h, targets, lang));
    const actions = (await store.recentActions(gc, 20)).map((x) => actionView(x, lang));
    return { json: { ok: true, config: config.view(cfg), targets, hosts, actions, now: Date.now() } };
  }

  if (a === 'targets' && seg.length === 1 && m === 'GET') return { json: { ok: true, targets: await targetsOf(gc) } };

  if (a === 'actions' && seg.length === 2 && m === 'GET') {
    const id = posInt(b);
    const act = id ? await store.getAction(gc, id) : null;
    if (!act) throw fail('NOT_FOUND');
    return { json: { ok: true, action: actionView(await control.refresh(gc, act), lang) } };
  }

  if (a !== 'hosts') throw fail('NOT_FOUND');
  const targets = await targetsOf(gc);

  if (seg.length === 1 && m === 'POST') {
    const { fields, secret } = await hostFields(gc, body, null, targets);
    const h = await store.createHost(gc, fields);
    await store.setSecret(gc, h.id, secret);
    gc.log.info('proxmox connection added', `#${h.id}`, `by ${req.user.name || req.user.id}`);
    return { json: { ok: true, host: await hostView(gc, h, targets, lang) } }; // the page asks for /refresh next
  }

  if (seg.length === 2 && b === 'test' && m === 'POST') {
    const existing = body.host_id != null ? await store.getHost(gc, posInt(body.host_id)) : null;
    if (body.host_id != null && !existing) throw fail('NOT_FOUND');
    const idx = Number.isInteger(body.target_index) ? body.target_index : (existing ? existing.target_index : null);
    if (idx == null || !targets.some((x) => x.index === idx)) throw fail('TARGET_REQUIRED');
    const tokenId = typeof body.token_id === 'string' && body.token_id.trim() ? body.token_id.trim() : (existing ? existing.token_id : '');
    if (!pve.validTokenId(tokenId)) throw fail('TOKEN_ID_INVALID');
    const given = typeof body.token_secret === 'string' ? body.token_secret.trim() : '';
    const secret = given || (existing ? await store.secretOf(gc, existing.id) : '');
    if (!pve.validSecret(secret || '')) throw fail('SECRET_INVALID');
    return { json: { ok: true, result: await poll.testConnection(gc, { target_index: idx, token_id: tokenId, secret }) } };
  }

  const id = posInt(b);
  const host = id ? await store.getHost(gc, id) : null;
  if (!host) throw fail('NOT_FOUND');

  if (seg.length === 2 && m === 'PUT') {
    const { fields, secret } = await hostFields(gc, body, host, targets);
    if (secret) await store.setSecret(gc, id, secret);
    const changedAccess = secret || fields.target_index !== undefined || fields.token_id !== undefined || fields.enabled === true;
    const h = await store.updateHost(gc, id, { ...fields, ...(changedAccess ? { next_poll_at: 0, error_count: 0 } : {}) });
    gc.log.info('proxmox connection changed', `#${id}`, Object.keys(fields).concat(secret ? ['token_secret'] : []).join(','), `by ${req.user.name || req.user.id}`);
    return { json: { ok: true, host: await hostView(gc, h, targets, lang) } };
  }
  if (seg.length === 2 && m === 'DELETE') {
    await store.removeHost(gc, id);
    gc.log.info('proxmox connection removed', `#${id}`, `by ${req.user.name || req.user.id}`);
    return { json: { ok: true } };
  }
  if (seg.length === 3 && c === 'refresh' && m === 'POST') {
    if (!host.enabled) throw fail('HOST_DISABLED');
    const r = await poll.pollHost(gc, host, await config.load(gc), { timeoutMs: INTERACTIVE_TIMEOUT_MS });
    try { await alerts.check(gc, [r]); } catch { /* logged in check */ }
    return { json: { ok: true, result: { ok: r.ok, error: r.error, error_text: errorText(r.error, lang) }, host: await hostView(gc, r.host, targets, lang) } };
  }
  if (seg.length === 5 && c === 'guests') {
    const vmid = posInt(d);
    if (!vmid || !pve.validVmid(vmid)) throw fail('NOT_FOUND');
    if (e === 'watch' && m === 'PUT') {
      if (typeof body.watched !== 'boolean') throw fail('INVALID');
      return { json: { ok: true, watched: await store.setWatched(gc, id, vmid, body.watched) } };
    }
    if (e === 'action' && m === 'POST') {
      const action = typeof body.action === 'string' ? body.action : '';
      if (!pve.ACTIONS.includes(action)) throw fail('ACTION_INVALID');
      // the page asked and the administrator confirmed — a hard stop twice
      if (body.confirm !== true || (action === 'stop' && body.confirm_hard !== true)) throw fail('CONFIRM_REQUIRED');
      if (!host.enabled) throw fail('HOST_DISABLED');
      const act = await control.run(gc, host, vmid, action, req.user);
      return { json: { ok: true, action: actionView(act, lang) } };
    }
  }
  throw fail('NOT_FOUND');
}

const state = { ticking: false };
const TICK_BUDGET_MS = 80000;

module.exports = {
  async start(gc) {
    alerts.reset();
    gc.log.info('proxmox started', gc.plugin.version);
  },

  async request(req, gc) {
    const lang = req.lang;
    try {
      const seg = String(req.path || '/').split('/').filter(Boolean);
      if (!seg.length) throw fail('NOT_FOUND');
      // administrators only, never a portal viewer (the plugin has no portal part)
      if (!req.user || req.user.portal || req.user.role !== 'admin') throw fail('FORBIDDEN');
      return await adminRoute(req, gc, seg, lang);
    } catch (e) {
      if (!ERRORS[e && e.code]) gc.log.warn('request failed', req.method, String(req.path || '').split('/').slice(0, 3).join('/'), (e && e.code) || 'error');
      return errorResponse(e, lang);
    }
  },

  async render(view, gc) {
    return { html: ui.render(view, t) };
  },

  /**
   * The portal shows nothing of this plugin; the own tab (ui.portal) exists only so the
   * apps' start card can carry the Start tile — visible for an administrator's app only.
   */
  async portalVisible({ user } = {}) {
    return quick.isAdmin(user) && user.app === true;
  },

  /** Start tile of the apps (administrators only): „Proxmox“ with guests running, CPU, RAM, storage. */
  async portalTiles({ user, lang } = {}, gc) {
    return quick.tiles(gc, user, lang === 'en' ? 'en' : 'de', t, errorText);
  },

  /** Quick actions of the apps (administrators only, at most 16): refresh per connection, start/shut down and reboot per watched guest. */
  async quickActions({ user, lang } = {}, gc) {
    return quick.list(gc, user, lang === 'en' ? 'en' : 'de', t, errorText);
  },

  /**
   * Runs one of them (the host only passes an id quickActions just listed for this viewer; the
   * administrator is checked here again). `target` 'on' | 'off' (GateControl ≥ 1.173.0): start
   * unless running / shut down unless stopped — never flipped, never a hard stop.
   */
  async runQuickAction(args, gc) {
    return quick.run(gc, args, t, errorText);
  },

  /**
   * Background (every 30 s): the connections whose poll is due, then the
   * notifications from their results, then running control tasks — none
   * started after 80 s, so a slow host never runs the tick into the host's
   * 120 s limit; an overlapping run is skipped.
   */
  async tick(gc) {
    if (state.ticking) return;
    state.ticking = true;
    try {
      const now = Date.now();
      const cfg = await config.load(gc);
      const results = await poll.pollDue(gc, cfg, now, now + TICK_BUDGET_MS);
      if (results.length) { try { await alerts.check(gc, results, { now }); } catch { /* logged in check */ } }
      await control.refreshRunning(gc);
    } finally { state.ticking = false; }
  },

  async settingsChanged(values, gc) {
    // a shorter interval or the update list switched on: poll every connection soon
    for (const h of await store.listHosts(gc)) await store.updateHost(gc, h.id, { next_poll_at: 0 });
  },

  _state: state,
};
