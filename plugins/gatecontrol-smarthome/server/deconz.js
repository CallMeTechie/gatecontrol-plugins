'use strict';

// deCONZ REST client (port of GateControl's src/services/smarthome/deconzClient.js).
// The plugin has no network of its own: every request goes through the host
// to the administrator-assigned home target "gateway" (assignment `index`),
// e.g. a GateControl route via a gateway — the host adds the companion proxy
// and its X-Gateway-Target-Domain header (gc.net.fetchTarget).

const TARGET = 'gateway';
const API_KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function briToDeconz(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return Math.round((p / 100) * 254);
}
function briFromDeconz(raw) {
  const r = Math.max(0, Math.min(254, Number(raw) || 0));
  return Math.round((r / 254) * 100);
}

function toDeconzBody(patch) {
  const body = {};
  if ('on' in patch) body.on = Boolean(patch.on);
  if ('bri' in patch) body.bri = briToDeconz(patch.bri);
  if ('ct' in patch) body.ct = Number(patch.ct);
  if ('hue' in patch) body.hue = Number(patch.hue);
  if ('sat' in patch) body.sat = Number(patch.sat);
  if ('xy' in patch && Array.isArray(patch.xy)) body.xy = patch.xy.map(Number);
  return body;
}

function codeError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

/** A deCONZ id as a path segment (numbers; scenes are "<group>/<scene>" and split before). */
function seg(id) {
  const s = String(id);
  if (!ID_RE.test(s)) throw codeError('SMARTHOME_RULE_INVALID', 'invalid deCONZ id');
  return s;
}

function validApiKey(k) {
  return typeof k === 'string' && API_KEY_RE.test(k);
}

/**
 * @param {object} gc            host API
 * @param {{index:number|null, apiKey?:string|null, timeoutMs?:number}} o
 */
function createClient(gc, { index, apiKey = null, timeoutMs = 10000 } = {}) {
  if (!Number.isInteger(index) || index < 0) throw codeError('SMARTHOME_NO_TARGET', 'gateway has no access target');
  if (apiKey != null && !validApiKey(apiKey)) throw codeError('SMARTHOME_NO_API_KEY', 'invalid api key');

  async function raw(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await gc.net.fetchTarget(TARGET, path, { index, method, ...(body !== undefined ? { json: body } : {}), timeoutMs });
    } catch (e) {
      // ERR_NET_DENIED: no (longer an) assignment with this index — or the
      // assigned address is one the host never lets a plugin reach
      if (e && e.code === 'ERR_NET_DENIED') {
        if (/no target assigned|not assigned|declares no target|not declared/.test(String(e.message))) throw codeError('SMARTHOME_NO_TARGET', 'gateway access target is not assigned');
        throw codeError('SMARTHOME_TARGET_DENIED', 'access target not reachable for plugins');
      }
      throw codeError('DECONZ_UNREACHABLE', 'gateway not reachable');
    }
    if (!res || res.status < 200 || res.status >= 300) throw codeError(`DECONZ_HTTP_${res ? res.status : 0}`, `deconz_http_${res ? res.status : 0}`);
    try { return JSON.parse(res.body || 'null'); } catch { throw codeError('DECONZ_BAD_RESPONSE', 'gateway answered no JSON'); }
  }

  // deCONZ answers are arrays of {success}/{error}; throws on error.
  function assertNoError(arr) {
    if (Array.isArray(arr)) {
      const err = arr.find((x) => x && x.error);
      if (err) {
        const e = new Error(String(err.error.description || `deconz_error_${err.error.type}`).slice(0, 200));
        e.code = err.error.type === 101 ? 'DECONZ_LINK_BUTTON_NOT_PRESSED' : `DECONZ_ERR_${err.error.type}`;
        throw e;
      }
    }
    return arr;
  }

  function firstId(arr) {
    const ok = Array.isArray(arr) ? arr.find((x) => x && x.success && x.success.id != null) : null;
    return ok ? String(ok.success.id) : null;
  }

  async function acquireApiKey() {
    const out = assertNoError(await raw('/api', { method: 'POST', body: { devicetype: 'GateControl' } }));
    const ok = Array.isArray(out) ? out.find((x) => x && x.success) : null;
    if (!ok || !validApiKey(ok.success.username)) throw codeError('DECONZ_NO_KEY', 'deconz_no_key');
    return { apiKey: ok.success.username };
  }

  const api = (p) => {
    if (!apiKey) throw codeError('SMARTHOME_NO_API_KEY', 'gateway has no api key');
    return `/api/${apiKey}${p}`;
  };

  return {
    acquireApiKey,
    // without a key: /api/config (keyless) as a reachability probe
    getConfig: () => (apiKey ? raw(api('/config')) : raw('/api/config')),
    getLights: () => raw(api('/lights')),
    getGroups: () => raw(api('/groups')),
    getSensors: () => raw(api('/sensors')),
    setLightState: (id, patch) => raw(api(`/lights/${seg(id)}/state`), { method: 'PUT', body: toDeconzBody(patch) }).then(assertNoError),
    setGroupState: (id, patch) => raw(api(`/groups/${seg(id)}/action`), { method: 'PUT', body: toDeconzBody(patch) }).then(assertNoError),
    recallScene: (groupId, sceneId) => raw(api(`/groups/${seg(groupId)}/scenes/${seg(sceneId)}/recall`), { method: 'PUT', body: {} }).then(assertNoError),
    getRules: () => raw(api('/rules')),
    createRule: (rule) => raw(api('/rules'), { method: 'POST', body: rule }).then(assertNoError).then(firstId),
    updateRule: (id, rule) => raw(api(`/rules/${seg(id)}`), { method: 'PUT', body: rule }).then(assertNoError),
    deleteRule: (id) => raw(api(`/rules/${seg(id)}`), { method: 'DELETE' }),
    createSchedule: (sched) => raw(api('/schedules'), { method: 'POST', body: sched }).then(assertNoError).then(firstId),
    deleteSchedule: (id) => raw(api(`/schedules/${seg(id)}`), { method: 'DELETE' }),
    createClipSensor: (sensor) => raw(api('/sensors'), { method: 'POST', body: sensor }).then(assertNoError).then(firstId),
    setClipSensorState: (id, state) => raw(api(`/sensors/${seg(id)}/state`), { method: 'PUT', body: state }).then(assertNoError),
    deleteClipSensor: (id) => raw(api(`/sensors/${seg(id)}`), { method: 'DELETE' }), // CLIP sensors live under /sensors
  };
}

module.exports = { createClient, briToDeconz, briFromDeconz, toDeconzBody, validApiKey, codeError, TARGET };
