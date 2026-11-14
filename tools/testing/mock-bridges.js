'use strict';

// gc.bridges for the mock host (tools/testing/mock-host.js): the messenger bridges of GateControl
// (src/services/bridges, hostApi.js bridgesCall, the child bootstrap's makeBridges; docs/plugins.md "Messenger
// bridges", docs/feature-messenger-bridges.md). A PREVIEW in GateControl — no released version has it yet, so it is
// opt-in only: opts.bridges; only a plugin with permissions.bridges: true has gc.bridges then (an older GateControl
// ignores the key).
//
//   createHost(dir, { bridges: true })                         preview on, bridges off (the default of a server)
//   createHost(dir, { bridges: { preview: false } })           gc.bridges exists, status() → { available: false, reason: 'preview_off' }
//   createHost(dir, { bridges: { enabled: true, networks: { whatsapp: true }, running: true } })
//
// It stands in for the server AND for the bridge behind it (no WhatsApp, no Matrix): the "phone" is the test.
//   host.bridges.confirm(processId)          the person confirmed the code / scanned the QR code on the phone
//   host.bridges.expire(processId)           the code ran out
//   host.bridges.logOut(userId, loginId)     the service dropped the linked device (state logged_out)
//   host.bridges.setHost({ state, error, running, memMb })   what update.sh reported
//   host.bridges.setHost({ bridgeDown: true })   reported as running, but the bridge itself does not answer
//   host.bridges.oddStep = 'webauthn'        the next login starts with a step GateControl does not offer
//   host.bridges.setHost({ outdated: true })     the bridge runs an older image than GateControl pins (networks[].outdated)
//   host.bridges.setHost({ probe: {…} })         what `update.sh bridges-probe` measured (status().host.probe)
//   host.bridges.acting(userId, fn)          run fn while that person has a changing request to ANOTHER plugin in
//                                            flight (the Familie page calling this plugin's service) — unlinkFor
//   createHost(dir, { bridges: { …, version: 1 } })   a GateControl whose gc.bridges has no unlinkFor yet (1.273.x)
//   host.bridges.state                       { enabled, networks, logins: Map userId → [...], processes: Map, log: [{ op, … }] }
//
// Like the host: status() anywhere; configure() only inside a changing request of an administrator (ERR_NOT_PERSON /
// ERR_NOT_ADMIN); everything with a userId only while a request of THAT person is in flight (flows / logins: any
// request, the rest a changing one) — else ERR_NOT_PERSON. A bridge that is off → ERR_BRIDGES_UNAVAILABLE (reason
// 'off' / 'preview_off'), one that does not run → ERR_BRIDGE_UNREACHABLE ('not_running'); a refusal of the bridge →
// ERR_BRIDGE with a reason ('not_found', 'm_bad_json', 'fi_mau_whatsapp_login_timeout', 'unsupported_step').
// unlinkFor(userId, network, actor) (version 2): the one call for somebody else — it only ends links; `actor` must be
// another person with a changing request in flight right now (here or, with acting(), elsewhere), the target is
// never an administrator (ERR_BRIDGES_DENIED); logged as { op: 'unlink_for', userId, by, network, logins }.

const NETWORKS = ['whatsapp'];
const ID_RE = /^[A-Za-z0-9._:=+-]{1,128}$/;
const FLOWS = [
  { id: 'qr', name: 'QR', description: 'Scan a QR code from the app' },
  { id: 'phone', name: 'Pairing code', description: 'Enter a pairing code in the app' },
];

function install({ opts, perms, enabledUser, hostError, personCtx }) {
  const o = opts.bridges === true ? {} : (opts.bridges && typeof opts.bridges === 'object' ? opts.bridges : null);
  const host = !!o;
  if (host && perms.bridges != null && typeof perms.bridges !== 'boolean') throw hostError('ERR_INVALID', 'plugin.json: permissions.bridges: invalid');
  const on = host && perms.bridges === true;
  const st = {
    preview: !(o && o.preview === false),
    enabled: !!(o && o.enabled),
    networks: { whatsapp: !!(o && o.networks && o.networks.whatsapp) },
    host: { state: o && o.running ? 'running' : null, error: null, running: !!(o && o.running), memMb: o && o.running ? 88 : null, outdated: false, probe: null },
    logins: new Map(), processes: new Map(), log: [], seq: 0, oddStep: null, elsewhere: new Map(),
  };
  const version = o && o.version === 1 ? 1 : 2;

  const err = (code, message, reason) => { const e = hostError(code, message); if (reason) e.reason = reason; return e; };
  const need = () => { if (perms.bridges !== true) throw hostError('ERR_BRIDGES_DENIED', 'this plugin has no bridges permission'); };
  const refuse = (reason) => err('ERR_BRIDGE', 'the bridge refused or failed', reason);

  function status() {
    if (!st.preview) return { available: false, reason: 'preview_off', enabled: false, location: 'server', locations: [], networks: [], host: null, history: { enabled: false } };
    const up = st.enabled && st.host.state === 'running' && st.host.running;
    return {
      available: true, reason: null, enabled: st.enabled, location: 'server',
      locations: [{ id: 'server', kind: 'server', cores: 4, memMb: 7953, freeMb: 5017 }],
      networks: NETWORKS.map((id) => {
        let state = 'off';
        if (st.enabled && st.networks[id]) state = up ? 'running' : (st.host.state === 'failed' ? 'failed' : 'starting');
        return {
          id, enabled: st.networks[id], state, version: up ? (st.host.outdated ? '0.2609.0' : '0.2610.0') : null, memMb: up ? st.host.memMb : null, limitMb: up ? 512 : null,
          ...(version >= 2 ? { outdated: up && st.host.outdated === true, wantVersion: '0.2610.0' } : {}),
        };
      }),
      host: {
        state: st.enabled ? st.host.state : 'stopped', error: st.enabled ? st.host.error : null, checkedAt: st.host.state ? new Date().toISOString() : null,
        cron: 'ok', script: { host: version >= 2 ? 6 : 5, needed: version >= 2 ? 6 : 5 },
        homeserver: { running: up, memMb: up ? 61 : null, limitMb: up ? 384 : null, version: up ? '1.9.4' : null, ...(version >= 2 ? { outdated: false, wantVersion: '1.9.4' } : {}) },
        ...(version >= 2 ? { limitsProvisional: true, probe: st.host.probe || null } : {}),
      },
      history: { enabled: false },
    };
  }

  function admin() {
    const writers = [...personCtx.entries()].filter(([, e]) => e.write > 0).map(([uid]) => uid);
    if (!writers.length) throw hostError('ERR_NOT_PERSON', 'only inside a changing request (POST/PUT/PATCH/DELETE) of a signed-in person, or with { actor }');
    if (writers.length !== 1) throw hostError('ERR_NOT_PERSON', 'several people are changing something right now — name the acting person with { actor }');
    const u = enabledUser(writers[0]);
    if (!u) throw hostError('ERR_NOT_PERSON', 'unknown or disabled person');
    if (u.role !== 'admin') throw hostError('ERR_NOT_ADMIN', 'only an administrator');
    return u;
  }

  /** the person of the call: their own request must be in flight */
  function person(userId, write) {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw hostError('ERR_INVALID', 'invalid user id');
    const e = personCtx.get(userId);
    if (!e || (write ? e.write <= 0 : e.read + e.write <= 0)) {
      throw hostError('ERR_NOT_PERSON', write ? 'only inside a changing request (POST/PUT/PATCH/DELETE) of that person' : 'only inside a request of that person');
    }
    return userId;
  }

  function bridge(network) {
    if (!NETWORKS.includes(network)) throw hostError('ERR_INVALID', 'unknown network');
    if (!st.preview) throw err('ERR_BRIDGES_UNAVAILABLE', 'the bridges are not offered on this server', 'preview_off');
    if (!st.enabled || !st.networks[network]) throw err('ERR_BRIDGES_UNAVAILABLE', 'this bridge is switched off', 'off');
    if (!st.host.running || st.host.bridgeDown) throw err('ERR_BRIDGE_UNREACHABLE', 'connect ENOENT', 'not_running');
  }
  const id = (v) => { if (!ID_RE.test(String(v || ''))) throw hostError('ERR_INVALID', 'invalid id'); return v; };
  const proc = (userId, processId) => {
    const p = st.processes.get(id(processId));
    if (!p || p.userId !== userId) throw refuse('not_found');
    return p;
  };

  function complete(p) {
    const loginId = `login-${++st.seq}`;
    const list = st.logins.get(p.userId) || [];
    list.push({ id: loginId, name: p.phone || '+490000000', state: 'connected', since: new Date().toISOString(), error: null });
    st.logins.set(p.userId, list);
    st.processes.delete(p.id);
    st.log.push({ op: 'linked', userId: p.userId, network: p.network, loginId });
    return { processId: p.id, step: { id: 'fi.mau.whatsapp.login.complete', type: 'complete', instructions: 'Successfully logged in', loginId } };
  }

  const api = {
    'bridges.status': async () => { need(); return status(); },
    'bridges.configure': async ({ patch }) => {
      need();
      const who = admin();
      if (!st.preview) throw err('ERR_BRIDGES_UNAVAILABLE', 'the bridges are not offered on this server', 'preview_off');
      const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : null;
      if (!p) throw hostError('ERR_INVALID', 'patch: an object');
      for (const k of Object.keys(p)) if (k !== 'enabled' && k !== 'networks') throw hostError('ERR_INVALID', 'unknown key');
      if (p.enabled !== undefined && typeof p.enabled !== 'boolean') throw hostError('ERR_INVALID', 'enabled: a boolean');
      if (p.networks !== undefined) {
        if (!p.networks || typeof p.networks !== 'object' || Array.isArray(p.networks)) throw hostError('ERR_INVALID', 'networks: an object');
        for (const [n, v] of Object.entries(p.networks)) if (!NETWORKS.includes(n) || typeof v !== 'boolean') throw hostError('ERR_INVALID', 'networks: unknown network or not a boolean');
        Object.assign(st.networks, p.networks);
      }
      if (p.enabled !== undefined) st.enabled = p.enabled;
      st.log.push({ op: 'configure', by: who.id, enabled: st.enabled, networks: { ...st.networks } });
      return status();
    },
    'bridges.login.flows': async ({ userId, network }) => { need(); person(userId, false); bridge(network); return FLOWS.map((f) => ({ ...f })); },
    'bridges.login.start': async ({ userId, network, flowId }) => {
      need(); person(userId, true); bridge(network);
      if (!FLOWS.some((f) => f.id === id(flowId))) throw refuse('not_found');
      if (st.oddStep) { st.oddStep = null; throw refuse('unsupported_step'); }
      const p = { id: `proc-${++st.seq}`, userId, network, flow: flowId, phone: null, settled: null };
      st.processes.set(p.id, p);
      if (flowId === 'phone') {
        return { processId: p.id, step: { id: 'fi.mau.whatsapp.login.phone', type: 'user_input', instructions: 'Enter your phone number',
          fields: [{ id: 'phone_number', type: 'phone_number', name: 'Phone number', description: 'Include the country code with a +', optional: false }] } };
      }
      return { processId: p.id, step: { id: 'fi.mau.whatsapp.login.qr', type: 'display_and_wait', instructions: 'Scan the QR code', display: { type: 'qr', data: '2@fake-qr-payload,one,two,three' } } };
    },
    'bridges.login.step': async ({ userId, network, processId, stepId, kind, input }) => {
      need(); person(userId, true); bridge(network);
      id(stepId);
      if (kind !== 'user_input' && kind !== 'display_and_wait') throw hostError('ERR_INVALID', 'invalid step kind');
      const p = proc(userId, processId);
      if (kind === 'user_input') {
        if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) throw hostError('ERR_INVALID', 'input: an object');
        for (const [k, v] of Object.entries(input)) if (!ID_RE.test(k) || typeof v !== 'string' || v.length > 500) throw hostError('ERR_INVALID', 'input: invalid field');
        if (!/^\+[0-9]{6,15}$/.test(String(input.phone_number || ''))) throw refuse('m_bad_json');
        p.phone = input.phone_number;
        return { processId: p.id, step: { id: 'fi.mau.whatsapp.login.pairing_code', type: 'display_and_wait', instructions: 'Enter the code in the app', display: { type: 'code', data: 'K7P2-M4X9' } } };
      }
      // the host asks the bridge once and lets the caller poll: { waiting: true } until the phone answered
      if (!p.settled) return { processId: p.id, waiting: true };
      if (p.settled === 'expire') { st.processes.delete(p.id); throw refuse('fi_mau_whatsapp_login_timeout'); }
      return complete(p);
    },
    'bridges.login.cancel': async ({ userId, network, processId }) => {
      need(); person(userId, true); bridge(network);
      st.processes.delete(proc(userId, processId).id);
      return { ok: true };
    },
    'bridges.logins': async ({ userId, network }) => {
      need(); person(userId, false); bridge(network);
      return (st.logins.get(userId) || []).map((l) => ({ network, ...l }));
    },
    'bridges.logout': async ({ userId, network, loginId }) => {
      need(); person(userId, true); bridge(network);
      const list = st.logins.get(userId) || [];
      if (!list.some((l) => l.id === id(loginId))) throw refuse('not_found');
      st.logins.set(userId, list.filter((l) => l.id !== loginId));
      st.log.push({ op: 'logout', userId, network, loginId });
      return { ok: true };
    },
    ...(version >= 2 ? {
      'bridges.unlinkFor': async ({ userId, network, actor }) => {
        need();
        if (!Number.isSafeInteger(userId) || userId <= 0) throw hostError('ERR_INVALID', 'invalid user id');
        if (!Number.isSafeInteger(actor) || actor <= 0 || actor === userId) throw hostError('ERR_INVALID', 'actor: another person');
        const e = personCtx.get(actor);
        if (!((e && e.write > 0) || (st.elsewhere.get(actor) || 0) > 0)) throw hostError('ERR_NOT_PERSON', 'only while the acting person has a changing request (POST/PUT/PATCH/DELETE) in flight');
        if (!enabledUser(actor)) throw hostError('ERR_NOT_PERSON', 'unknown or disabled person');
        const target = enabledUser(userId);
        if (target && target.role === 'admin') throw hostError('ERR_BRIDGES_DENIED', "an administrator's link is never ended by somebody else");
        bridge(network);
        const n = (st.logins.get(userId) || []).length;
        st.logins.set(userId, []);
        st.log.push({ op: 'unlink_for', userId, by: actor, network, logins: n });
        return { unlinked: n };
      },
    } : {}),
  };

  /** gc.bridges (the child bootstrap's shape) */
  const gcPart = (call) => Object.freeze({
    version,
    status: () => call('bridges.status', {}),
    configure: (patch) => call('bridges.configure', { patch }),
    login: Object.freeze({
      flows: (userId, network) => call('bridges.login.flows', { userId, network }),
      start: (userId, network, flowId) => call('bridges.login.start', { userId, network, flowId }),
      step: (userId, network, processId, stepId, kind, input) => call('bridges.login.step', { userId, network, processId, stepId, kind, input }),
      cancel: (userId, network, processId) => call('bridges.login.cancel', { userId, network, processId }),
    }),
    logins: (userId, network) => call('bridges.logins', { userId, network }),
    logout: (userId, network, loginId) => call('bridges.logout', { userId, network, loginId }),
    ...(version >= 2 ? { unlinkFor: (userId, network, actor) => call('bridges.unlinkFor', { userId, network, actor }) } : {}),
  });

  const settle = (processId, how) => {
    const p = st.processes.get(processId);
    if (!p) throw new Error('mock host: unknown login process ' + processId);
    p.settled = how;
  };
  const control = {
    state: st,
    confirm: (processId) => settle(processId, 'confirm'),
    expire: (processId) => settle(processId, 'expire'),
    logOut(userId, loginId) {
      const l = (st.logins.get(userId) || []).find((x) => x.id === loginId);
      if (!l) throw new Error('mock host: unknown login ' + loginId);
      l.state = 'logged_out'; l.error = 'wa-logged-out'; l.since = new Date().toISOString();
    },
    setHost(x = {}) { Object.assign(st.host, x); },
    async acting(userId, fn) {
      st.elsewhere.set(userId, (st.elsewhere.get(userId) || 0) + 1);
      try { return await fn(); } finally { st.elsewhere.set(userId, st.elsewhere.get(userId) - 1); }
    },
    set oddStep(v) { st.oddStep = v; },
  };

  return { on, api, gcPart, control };
}

module.exports = { install, NETWORKS, FLOWS };
