'use strict';

// GateControl with "Videos umwandeln" for the mock host (tools/testing/mock-host.js): gc.transcode (src/services/
// homeTranscode.js, hostApi.js transcodeCall, the child bootstrap's makeTranscode; docs/plugins.md "Video conversion",
// the gateway's docs/transcode.md). Opt-in: opts.transcode; only a plugin with permissions.transcode: true has
// gc.transcode (an older GateControl ignores the key — no gc.transcode; without the permission ERR_TRANSCODE_DENIED).
//
//   createHost(dir, { transcode: { gateways: [{ id, name, online, supported, enabled, state, service, caps,
//                                               roots: ['/volume2/mediathek'], trashDays, quality, software }] } })
//
// Each gateway is a small stand-in for the gateway with its service: submit queues a job (state queued), the test moves
// it on with host.transcode.job(gatewayId, id, patch) (e.g. { state: 'running', percent: 40, speed: 3.1 } or
// host.transcode.finish(gatewayId, id, { output, seconds }) → done with a result and a trash entry). Like the host:
//   available()                     { available, gateways: [...] } — gateways with the capability or the switch
//   report(gatewayId)               the last stored report (with reportedAt and the last known trash) | null
//   status(gatewayId)               live (stored as the last report too)
//   probe / submit / cancel / pause / resume / ack / restore / purge / settings — the host's checks first
//                                   (gateway known, capability, switch, online; id [A-Za-z0-9_-]{8,64}; path absolute,
//                                   plain, under a media folder of that gateway), errors with err.reason
//   on(handler)                     host.transcode.report(gatewayId) stores the gateway's state and delivers the hook
//                                   transcodeChanged { gatewayId, status } (status as report())
// host.transcode = { state, gateway(id), job, finish, fail, report, calls }.

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TRASH_DIR = '.gc-papierkorb';
const WORK_DIR = '.gc-umwandeln';
const PAUSE_DEFAULT = 900;
const ACTIVE = new Set(['queued', 'running', 'paused', 'verifying']);
const DONE = new Set(['done', 'failed', 'cancelled']);

function install({ opts, perms, hostError }) {
  const o = opts.transcode && typeof opts.transcode === 'object' ? opts.transcode : null;
  if (o && perms.transcode != null && typeof perms.transcode !== 'boolean') throw hostError('ERR_INVALID', 'plugin.json: permissions.transcode: invalid');
  const on = !!o && perms.transcode === true;
  const copy = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const err = (code, message, reason) => Object.assign(hostError(code, message), reason ? { reason } : {});
  const clock = () => (typeof o?.now === 'function' ? o.now() : Date.now());
  const isoNow = () => new Date(clock()).toISOString();
  const state = {
    gateways: ((o && o.gateways) || []).map((g) => ({
      id: g.id, name: g.name || 'Gateway', online: g.online !== false, supported: g.supported !== false, enabled: g.enabled !== false,
      service: g.service || 'managed', state: g.state || 'ready',
      caps: g.caps === undefined ? { device: 'ok', deviceGid: 937, driver: 'Intel iHD driver', encoders: ['vaapi_icq', 'vaapi_qvbr'], ffmpeg: '7.1.2', software: true } : copy(g.caps),
      roots: (g.roots || ['/volume2/mediathek']).slice(), free: g.free == null ? 1.9e12 : g.free,
      settings: { software: g.software === true, trashDays: g.trashDays || 14, quality: g.quality || 23 },
      jobs: [], trash: [], pause: { all: false, until: null }, report: null, reportTrash: null, reportedAt: null,
      fail: {},  // the next call of this kind fails: { submit: { code, reason } }
    })),
    handlers: [], calls: [],
  };
  const need = () => { if (perms.transcode !== true) throw err('ERR_TRANSCODE_DENIED', 'this plugin has no transcode permission'); };
  const gwOf = (v) => {
    const n = typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : v;
    if (!Number.isSafeInteger(n) || n <= 0) throw err('ERR_INVALID', 'gatewayId: a gateway id', 'invalid_request');
    const g = state.gateways.find((x) => x.id === n);
    if (!g) throw err('ERR_NOT_FOUND', 'no such gateway', 'unknown_gateway');
    return g;
  };
  const needGw = (v) => {
    const g = gwOf(v);
    if (!g.supported) throw err('ERR_TRANSCODE_UNSUPPORTED', 'the gateway is too old', 'gateway_update');
    if (!g.enabled) throw err('ERR_TRANSCODE_UNSUPPORTED', 'switched off on this gateway', 'feature_disabled');
    if (!g.online) throw err('ERR_TRANSCODE_OFFLINE', 'the gateway is offline', 'offline');
    if (g.service !== 'managed') throw err('ERR_TRANSCODE_SERVICE', 'the service umwandeln is missing', g.service === 'absent' ? 'service_absent' : 'service_missing');
    return g;
  };
  const injected = (g, kind) => {
    const f = g.fail[kind];
    if (!f) return;
    delete g.fail[kind];
    throw err(f.code, f.message || f.code, f.reason);
  };
  const needId = (v) => { if (typeof v !== 'string' || !ID_RE.test(v)) throw err('ERR_INVALID', 'id: [A-Za-z0-9_-]{8,64}', 'invalid_request'); return v; };
  const needPath = (g, v) => {
    if (typeof v !== 'string' || !v || v.length > 4096 || v[0] !== '/' || /[\0-\x1f\x7f]/.test(v)) throw err('ERR_INVALID', 'path: an absolute path', 'bad_path');
    if (v.split('/').slice(1).some((s) => s === '' || s === '.' || s === '..' || s === TRASH_DIR || s === WORK_DIR)) throw err('ERR_INVALID', 'path: not normalised', 'bad_path');
    if (!g.roots.some((r) => v.startsWith(r + '/'))) throw err('ERR_INVALID', 'path: not under a media folder of this gateway', 'outside_roots');
    return v;
  };
  const jobView = (j) => copy(j);
  const statusOf = (g) => ({
    at: isoNow(), enabled: g.enabled, service: g.service, state: g.state, caps: copy(g.caps),
    roots: g.roots.map((p) => ({ path: p, state: 'ok', free: g.free, total: 4e12 })),
    settings: { ...g.settings, verifyDecode: true, minFreeGb: 20, minFreePct: 5 },
    pause: copy(g.pause), jobs: g.jobs.map(jobView), trash: copy(g.trash),
  });
  const store = (g) => {
    const st = statusOf(g);
    const { trash, ...rest } = st;
    g.report = rest;
    g.reportTrash = trash;
    g.reportedAt = isoNow();
    return { ...rest, trash: copy(trash), reportedAt: g.reportedAt };
  };
  const findJob = (g, id) => g.jobs.find((j) => j.id === id) || null;

  const api = {};
  const rec = (name, fn) => { api['transcode.' + name] = async (args) => { need(); state.calls.push({ name, args: copy(args || {}) }); return fn(args || {}); }; };
  rec('available', () => {
    const gateways = state.gateways.filter((g) => g.supported || g.enabled).map((g) => ({
      id: g.id, name: g.name, online: g.online, supported: g.supported, minGateway: '1.50.0', enabled: g.enabled,
      service: g.report ? g.report.service : g.service, state: g.report ? g.report.state : g.state, caps: copy(g.caps),
      roots: g.roots.map((p) => ({ path: p, state: 'ok', free: g.free, total: 4e12 })),
      settings: { roots: g.roots.slice(), software: g.settings.software, trashDays: g.settings.trashDays, quality: g.settings.quality },
      jobs: { queued: g.jobs.filter((j) => j.state === 'queued').length, done: g.jobs.filter((j) => j.state === 'done').length, failed: g.jobs.filter((j) => j.state === 'failed').length },
      current: (() => { const j = g.jobs.find((x) => ['running', 'paused', 'verifying'].includes(x.state)); return j ? { id: j.id, state: j.state, percent: j.percent } : null; })(),
      trash: { count: g.trash.length, bytes: g.trash.reduce((n, x) => n + (x.size || 0), 0) },
      reportedAt: g.reportedAt,
    }));
    return { available: gateways.some((g) => g.supported && g.enabled), gateways };
  });
  rec('report', ({ gatewayId }) => {
    const g = gwOf(gatewayId);
    return g.report ? { ...copy(g.report), trash: copy(g.reportTrash || []), reportedAt: g.reportedAt } : null;
  });
  rec('status', ({ gatewayId }) => { const g = needGw(gatewayId); injected(g, 'status'); return store(g); });
  rec('probe', ({ gatewayId, path }) => {
    const g = needGw(gatewayId);
    needPath(g, path);
    injected(g, 'probe');
    return { path, source: { codec: 'h264', profile: 'High 10', pixFmt: 'yuv420p10le', bits: 10, width: 1920, height: 1080, fps: 50, duration: 1361, container: 'matroska,webm', video: 1, audio: 2, subtitles: 1, attachments: 0, pictures: 0, other: 0, chapters: 6, size: 812000000 }, freeKb: Math.round(g.free / 1024) };
  });
  rec('submit', ({ opts: a0 }) => {
    const a = a0 || {};
    const g = needGw(a.gatewayId);
    const id = needId(a.id);
    const path = needPath(g, a.path);
    if (a.quality !== undefined && a.quality !== null && (!Number.isInteger(a.quality) || a.quality < 16 || a.quality > 32)) throw err('ERR_INVALID', 'quality: 16…32', 'invalid_request');
    injected(g, 'submit');
    const same = findJob(g, id);
    if (same) {
      if (same.path !== path) throw err('ERR_TRANSCODE_CONFLICT', 'id with another path', 'duplicate_id');
      return { job: jobView(same) };
    }
    if (g.jobs.some((j) => j.path === path && ACTIVE.has(j.state))) throw err('ERR_TRANSCODE_CONFLICT', 'already queued', 'already_queued');
    if (g.jobs.filter((j) => j.state === 'queued').length >= 32) throw err('ERR_TRANSCODE_BUSY', 'queue full', 'queue_full');
    const j = { id, path, state: 'queued', error: null, percent: null, fps: null, speed: null, paused: false, software: a.software === false ? false : g.settings.software, submittedAt: isoNow(), startedAt: null, finishedAt: null, result: null };
    g.jobs.push(j);
    return { job: jobView(j) };
  });
  rec('cancel', ({ gatewayId, id }) => {
    const g = needGw(gatewayId);
    const j = findJob(g, needId(id));
    if (!j) throw err('ERR_NOT_FOUND', 'unknown job', 'not_found');
    if (ACTIVE.has(j.state)) Object.assign(j, { state: 'cancelled', finishedAt: isoNow() });
    return { job: jobView(j) };
  });
  rec('pause', ({ gatewayId, opts: p0 }) => {
    const g = needGw(gatewayId);
    const p = p0 || {};
    if (p.id !== undefined) {
      const j = findJob(g, needId(p.id));
      if (!j) throw err('ERR_NOT_FOUND', 'unknown job', 'not_found');
      if (!ACTIVE.has(j.state)) throw err('ERR_TRANSCODE_CONFLICT', 'not active', 'not_active');
      j.paused = true;
      if (j.state === 'running') j.state = 'paused';
    } else {
      if (p.ttlSec !== undefined && (!Number.isInteger(p.ttlSec) || p.ttlSec < 10 || p.ttlSec > 86400)) throw err('ERR_INVALID', 'ttlSec: 10…86400', 'invalid_request');
      g.pause = { all: true, until: new Date(clock() + (p.ttlSec || PAUSE_DEFAULT) * 1000).toISOString() };
    }
    return { pause: copy(g.pause) };
  });
  rec('resume', ({ gatewayId, opts: p0 }) => {
    const g = needGw(gatewayId);
    const p = p0 || {};
    if (p.id !== undefined) {
      const j = findJob(g, needId(p.id));
      if (!j) throw err('ERR_NOT_FOUND', 'unknown job', 'not_found');
      j.paused = false;
      if (j.state === 'paused') j.state = 'running';
    } else g.pause = { all: false, until: null };
    return { pause: copy(g.pause) };
  });
  rec('ack', ({ gatewayId, ids }) => {
    const g = needGw(gatewayId);
    if (!Array.isArray(ids) || !ids.length || ids.length > 200) throw err('ERR_INVALID', 'ids: 1…200 job ids', 'invalid_request');
    ids.forEach(needId);
    const before = g.jobs.length;
    g.jobs = g.jobs.filter((j) => !(ids.includes(j.id) && DONE.has(j.state)));
    return { removed: before - g.jobs.length };
  });
  rec('restore', ({ gatewayId, id }) => {
    const g = needGw(gatewayId);
    needId(id);
    injected(g, 'restore');
    const t = g.trash.find((x) => x.id === id);
    if (!t) throw err('ERR_TRANSCODE_FAILED', 'not in the trash', 'not_in_trash');
    g.trash = g.trash.filter((x) => x !== t);
    return { id, restored: true };
  });
  rec('purge', ({ gatewayId, opts: p0 }) => {
    const g = needGw(gatewayId);
    const p = p0 || {};
    if (p.all === true && p.id === undefined) g.trash = [];
    else if (p.id !== undefined && p.all === undefined) {
      needId(p.id);
      if (!g.trash.some((x) => x.id === p.id)) throw err('ERR_TRANSCODE_FAILED', 'not in the trash', 'not_in_trash');
      g.trash = g.trash.filter((x) => x.id !== p.id);
    } else throw err('ERR_INVALID', 'purge: { id } or { all: true }', 'invalid_request');
    return { purged: true };
  });
  rec('settings', ({ gatewayId, opts: p0 }) => {
    const g = gwOf(gatewayId);
    const p = p0 || {};
    const keys = Object.keys(p);
    if (!keys.length || keys.some((k) => k !== 'trashDays' && k !== 'quality')) throw err('ERR_INVALID', 'settings: trashDays and/or quality', 'invalid_request');
    if (p.trashDays !== undefined && (!Number.isInteger(p.trashDays) || p.trashDays < 1 || p.trashDays > 365)) throw err('ERR_INVALID', 'trashDays: 1…365', 'invalid_request');
    if (p.quality !== undefined && (!Number.isInteger(p.quality) || p.quality < 16 || p.quality > 32)) throw err('ERR_INVALID', 'quality: 16…32', 'invalid_request');
    Object.assign(g.settings, p);
    return { trashDays: g.settings.trashDays, quality: g.settings.quality };
  });

  const gcPart = (call) => Object.freeze({
    available: () => call('transcode.available', {}),
    report: (gatewayId) => call('transcode.report', { gatewayId }),
    status: (gatewayId) => call('transcode.status', { gatewayId }),
    probe: (gatewayId, path) => call('transcode.probe', { gatewayId, path }),
    submit: (x) => call('transcode.submit', { opts: x && typeof x === 'object' ? x : {} }),
    cancel: (gatewayId, id) => call('transcode.cancel', { gatewayId, id }),
    pause: (gatewayId, x) => call('transcode.pause', { gatewayId, opts: x && typeof x === 'object' ? x : {} }),
    resume: (gatewayId, x) => call('transcode.resume', { gatewayId, opts: x && typeof x === 'object' ? x : {} }),
    ack: (gatewayId, ids) => call('transcode.ack', { gatewayId, ids }),
    restore: (gatewayId, id) => call('transcode.restore', { gatewayId, id }),
    purge: (gatewayId, x) => call('transcode.purge', { gatewayId, opts: x && typeof x === 'object' ? x : {} }),
    settings: (gatewayId, x) => call('transcode.settings', { gatewayId, opts: x && typeof x === 'object' ? x : {} }),
    on: (fn) => {
      if (typeof fn !== 'function') throw new TypeError('gc.transcode.on(handler)');
      state.handlers.push(fn);
      return () => { const i = state.handlers.indexOf(fn); if (i >= 0) state.handlers.splice(i, 1); };
    },
  });

  // ── test controls ──
  const gateway = (id) => { const g = state.gateways.find((x) => x.id === id); if (!g) throw new Error('mock transcode: no gateway ' + id); return g; };
  /** The gateway reports (POST /api/v1/gateway/transcode/report): stored, then the hook transcodeChanged → after the handlers ran. */
  async function report(gatewayId) {
    const g = gateway(gatewayId);
    const status = store(g);
    const arg = Object.freeze(copy({ gatewayId: g.id, status }));
    for (const fn of state.handlers.slice()) await fn(arg);
    return status;
  }
  /** Change a job as the service would (state, percent, speed, error, result …). */
  function job(gatewayId, id, patch) {
    const j = findJob(gateway(gatewayId), id);
    if (!j) throw new Error('mock transcode: no job ' + id);
    Object.assign(j, copy(patch));
    if (patch.state === 'running' && !j.startedAt) j.startedAt = isoNow();
    if (DONE.has(j.state) && !j.finishedAt) j.finishedAt = isoNow();
    return copy(j);
  }
  /** A job ends well: done with a result (source 10 bit → output 8 bit) and the original in the trash. */
  function finish(gatewayId, id, x = {}) {
    const g = gateway(gatewayId);
    const j = findJob(g, id);
    if (!j) throw new Error('mock transcode: no job ' + id);
    const duration = x.duration || 1361;
    const source = { codec: 'h264', profile: 'High 10', pixFmt: 'yuv420p10le', bits: 10, width: 1920, height: 1080, fps: 50, duration, video: 1, audio: 2, subtitles: 1, attachments: 0, chapters: 6, size: x.sourceSize || 812000000 };
    const output = { ...source, profile: 'High', pixFmt: 'yuv420p', bits: 8, duration: duration - 0.02, size: x.size || 1190000000 };
    const day = isoNow().slice(0, 10);
    const root = g.roots.find((r) => j.path.startsWith(r + '/'));
    const trashPath = root + '/' + TRASH_DIR + '/' + day + j.path.slice(root.length);
    Object.assign(j, { state: 'done', percent: 100, finishedAt: isoNow(), result: { source, output, mode: 'vaapi_icq', seconds: x.seconds || Math.round(duration / 3.2), trashPath, restored: null, resumed: false, freeKb: null, needKb: null, log: [] } });
    const expires = new Date(clock() + g.settings.trashDays * 86400000).toISOString();
    g.trash.push({ id: j.id, at: isoNow(), size: source.size, expiresAt: expires, path: trashPath });
    return copy(j);
  }
  /** A job fails with a code of the watcher (no_space, encode_failed …). */
  function failJob(gatewayId, id, code, result) {
    return job(gatewayId, id, { state: 'failed', error: code, result: { log: ['ffmpeg: error'], freeKb: code === 'no_space' ? 1000 : null, needKb: code === 'no_space' ? 2000000 : null, ...(result || {}) } });
  }

  return { on, api, gcPart, state, control: { state, gateway, report, job, finish, fail: failJob, calls: state.calls } };
}

module.exports = { install };
