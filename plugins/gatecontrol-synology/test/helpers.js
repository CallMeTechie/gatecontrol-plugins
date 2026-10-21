'use strict';

// Test helpers: a fake DSM (the DSM Web API answered from synthetic fixtures
// in test/fixtures — the documented response shapes, no real device) behind
// the mock host's home target "nas", and the users of a small household.

const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../../../tools/testing/mock-host');

const DIR = path.join(__dirname, '..');
const ADMIN = { id: 1, name: 'admin', role: 'admin' };
const ADA = { id: 2, name: 'Ada', role: 'user' };
const USERS = [ADMIN, ADA];

const ACCOUNT = 'gc-monitor';
const PASSWORD = 'S3cret-Pa55!word';

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

function netError(message, code = 'ERR_NET') { return Object.assign(new Error(message), { code }); }
const json = (o, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });

/**
 * A fake DSM. opts: { account, password, otp (2-step verification on, the
 * valid code), denied: [api] (105 for these), down (connection refused) }.
 * `dsm.state` is open for the tests (sessions, logins, calls, power, …).
 */
function fakeDsm(fx, opts = {}) {
  const f = typeof fx === 'string' ? fixture(fx) : clone(fx);
  const state = {
    fixture: f, account: opts.account || ACCOUNT, password: opts.password || PASSWORD, otp: opts.otp || null,
    denied: new Set(opts.denied || []), down: !!opts.down, error: null, loginError: null,
    sessions: new Map(), devices: new Set(), seq: 0, logins: [], logouts: 0, calls: [], requests: [], power: [], backups: [],
    // 1.2.0: File Station uploads (GateDrop): the files on the NAS by path, a forced DSM error code
    files: new Map(), uploads: [], uploadError: null,
  };
  const parseParam = (info, v) => {
    if (v == null) return v;
    if (info && info.requestFormat === 'JSON') { try { return JSON.parse(v); } catch { return v; } }
    return v;
  };
  async function fetch(p, o = {}) {
    state.requests.push({ path: p, method: o.method, form: o.form ? { ...o.form } : null, headers: { ...(o.headers || {}) } });
    if (state.down) throw netError('connect ECONNREFUSED 10.0.0.5:5000');
    if (state.error) { const e = state.error; if (e.once) state.error = null; if (e.throw) throw e.throw; return e.response; }
    const [pathname, qs] = p.split('?');
    if (pathname === '/webapi/query.cgi') {
      const q = new URLSearchParams(qs || '');
      const want = String(q.get('query') || '').split(',');
      const data = {};
      for (const a of want) if (f.api_info[a]) data[a] = f.api_info[a];
      return json({ success: true, data });
    }
    const form = o.form || {};
    const api = form.api;
    const info = f.api_info[api];
    if (!info || pathname !== '/webapi/' + info.path) return json({ success: false, error: { code: 102 } });
    const v = Number(form.version);
    if (!(v >= info.minVersion && v <= info.maxVersion)) return json({ success: false, error: { code: 104 } });
    if (api === 'SYNO.API.Auth') {
      if (form.method === 'logout') { state.sessions.delete(form._sid); state.logouts++; return json({ success: true }); }
      state.logins.push({ ...form, url: p });
      if (state.loginError) return json({ success: false, error: { code: state.loginError } });
      if (form.account !== state.account || form.passwd !== state.password) return json({ success: false, error: { code: 400 } });
      let did;
      if (state.otp) {
        if (!(form.device_id && state.devices.has(form.device_id))) {
          if (!form.otp_code) return json({ success: false, error: { code: 403 } });
          if (form.otp_code !== state.otp) return json({ success: false, error: { code: 404 } });
          if (form.enable_device_token === 'yes') { did = `did-${++state.seq}-${form.device_name}`; state.devices.add(did); }
        }
      }
      const sid = `sid-${++state.seq}`;
      const token = `tok-${state.seq}`;
      state.sessions.set(sid, token);
      return json({ success: true, data: { sid, synotoken: form.enable_syno_token === 'yes' ? token : undefined, did, is_portal_port: false } });
    }
    const token = state.sessions.get(form._sid);
    if (!token) return json({ success: false, error: { code: 119 } });
    if ((o.headers || {})['X-SYNO-TOKEN'] !== token) return json({ success: false, error: { code: 119 } });
    const params = {};
    for (const [k, val] of Object.entries(form)) if (!['api', 'version', 'method', '_sid'].includes(k)) params[k] = parseParam(info, val);
    state.calls.push({ api, method: form.method, version: v, params });
    if (state.denied.has(api)) return json({ success: false, error: { code: 105 } });
    if (api === 'SYNO.Core.System' && (form.method === 'reboot' || form.method === 'shutdown')) { state.power.push(form.method); return json({ success: true }); }
    if (api === 'SYNO.Backup.Task' && form.method === 'backup') { state.backups.push(params.task_id); return json({ success: true, data: { task_id: params.task_id } }); }
    const key = `${api}.${form.method}${params.type === 'storage' ? ':storage' : ''}`;
    if (!(key in f.responses)) return json({ success: false, error: { code: 103 } });
    return json({ success: true, data: f.responses[key] });
  }
  /** SYNO.FileStation.Upload through gc.net.uploadTarget (multipart: fields + file, _sid in the query). */
  async function upload(p, o = {}) {
    if (state.down) throw netError('connect ECONNREFUSED 10.0.0.5:5000');
    const q = o.query || {};
    const info = f.api_info['SYNO.FileStation.Upload'];
    if (!info || p !== '/webapi/' + info.path || q.api !== 'SYNO.FileStation.Upload' || q.method !== 'upload') return json({ success: false, error: { code: 102 } });
    const token = state.sessions.get(q._sid);
    if (!token || (o.headers || {})['X-SYNO-TOKEN'] !== token) return json({ success: false, error: { code: 119 } });
    const fields = o.fields || {};
    const full = `${fields.path}/${o.file.name}`;
    state.uploads.push({ path: fields.path, name: o.file.name, bytes: o.file.bytes, mime: o.file.mime, createParents: fields.create_parents, version: q.version });
    if (state.uploadError) return json({ success: false, error: { code: state.uploadError } });
    if (state.files.has(full)) return json({ success: false, error: { code: 1805 } });
    state.files.set(full, Buffer.from(o.file.data));
    return json({ success: true, data: {} });
  }
  return { fetch, upload, state, fixture: f };
}

/**
 * A host with the household users and NAS targets. opts.nas: [fakeDsm|null]
 * (one target per entry; label "nas-<i>"), opts.settings.
 */
async function withHost(opts, fn) {
  const list = opts.nas || [];
  const host = await createHost(DIR, {
    users: USERS,
    settings: opts.settings || {},
    notifyFail: opts.notifyFail,
    // 1.2.0 needs GateControl 1.193.0 (media up to 2 GB for GateDrop's hand-over, gc.net.uploadTarget)
    gatecontrol: opts.gatecontrol || '1.193.0',
    targets: { nas: list.map((d, i) => ({ label: `nas-${i}.home.example`, fetch: d ? d.fetch : undefined, upload: d ? d.upload : undefined })) },
  });
  await host.start();
  try { return await fn(host); } finally { await host.close(); }
}

const asAdmin = (host, method, p, body) => host.request({ method, path: p, body: body === undefined ? null : body, user: ADMIN });

/** Add a NAS through the API (target 0 by default) → id */
async function addNas(host, extra = {}) {
  const r = await asAdmin(host, 'POST', '/nas', { name: 'Keller', target_index: 0, username: ACCOUNT, password: PASSWORD, ...extra });
  if (r.status !== 201) throw new Error('add failed: ' + JSON.stringify(r.json));
  return r.json.nas.id;
}

module.exports = { DIR, ADMIN, ADA, USERS, ACCOUNT, PASSWORD, fixture, fakeDsm, withHost, asAdmin, addNas, netError, json };
