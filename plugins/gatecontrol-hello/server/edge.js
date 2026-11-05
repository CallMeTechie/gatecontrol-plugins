'use strict';

// gatecontrol-hello — the server side of the edge part (GateControl ≥ 1.228.0, docs/plugins.md "Edge part" ›
// "Server part: gc.edge"). gc.edge exists only in a plugin with an `edge` section in plugin.json:
//   gc.edge.gateways()                                 the gateways the plugin is set up for, with their state
//   gc.edge.call(gatewayId, method, params, { timeoutMs }) what the edge part's gc.handle(method) returned
//   gc.edge.on(name, handler)                          events of the edge part (gc.emit) and $online/$offline/$started
//   gc.edge.configure(gatewayId, data)                 data for the edge part's gc.config() — held in its memory only
// The configuration is never stored on the gateway: send it again on $started (the edge part runs there now) and
// whenever the settings change.

const NAME_MAX = 64;
const CALL_TIMEOUT_MS = 10000;

// the last heartbeat per gateway (in memory: after a restart of the plugin the next heartbeat comes within 60 s)
const heartbeats = new Map();

/** What the edge part gets as gc.config(). */
async function edgeConfig(gc) {
  const greeting = await gc.settings.get('greeting');
  return { greeting: typeof greeting === 'string' ? greeting : '' };
}

/** Hand the configuration to one gateway; false (logged) when it cannot take it now. */
async function configure(gc, gatewayId) {
  try {
    await gc.edge.configure(gatewayId, await edgeConfig(gc));
    return true;
  } catch (e) {
    gc.log.warn('edge configure failed', gatewayId, (e && e.code) || (e && e.message) || 'error');
    return false;
  }
}

/** Called from start(): the handlers of the edge part's events. false: no gc.edge (GateControl < 1.228.0). */
function setup(gc) {
  heartbeats.clear();
  if (!gc.edge) return false;
  gc.edge.on('$started', ({ gatewayId }) => configure(gc, gatewayId));
  gc.edge.on('heartbeat', ({ gatewayId, data, at }) => {
    const up = data && Number.isFinite(data.uptimeS) ? Math.max(0, Math.floor(data.uptimeS)) : null;
    heartbeats.set(gatewayId, { at: typeof at === 'string' ? at : new Date().toISOString(), uptimeS: up });
  });
  return true;
}

/** After the settings were saved: every gateway where the edge part runs gets the new greeting. */
async function configureAll(gc) {
  if (!gc.edge) return 0;
  let gateways;
  try { gateways = await gc.edge.gateways(); } catch (e) { gc.log.warn('edge gateways failed', (e && e.code) || 'error'); return 0; }
  let n = 0;
  for (const g of gateways) {
    if (g.state === 'running' && (await configure(gc, g.id))) n++;
  }
  return n;
}

/** GET edge/gateways → { ok, available, gateways: [{ id, name, state, stateText, online, version, heartbeat }] } */
async function list(gc, t) {
  if (!gc.edge) return { ok: true, available: false, gateways: [] };
  const gateways = (await gc.edge.gateways()).map((g) => ({
    id: g.id,
    name: g.name,
    state: g.state,
    stateText: t('state.' + g.state, t('state.unknown')),
    online: g.online === true,
    version: g.version || null,
    heartbeat: heartbeats.get(g.id) || null,
  }));
  return { ok: true, available: true, gateways };
}

/** The error of gc.edge.call as the page shows it: code, the edge part's own code (edge_error) and a text. */
function callError(e, t) {
  const code = (e && typeof e.code === 'string' && e.code) || 'error';
  // edge_error: "<the gateway's or edge part's code>: <message>", e.g. "invalid_name: …", "not_running: …"
  const m = code === 'edge_error' ? /^([A-Za-z0-9_.-]{1,32}):\s/.exec(String((e && e.message) || '')) : null;
  const detail = m ? m[1] : null;
  const text = (detail && t('error.' + detail, null)) || t('error.' + code, null) || t('error.unknown');
  return { ok: false, code, detail, error: text, message: String((e && e.message) || '').slice(0, 300) };
}

/** POST edge/greet { gatewayId, name } → { ok, result } or { ok: false, code, detail, error } */
async function greet(gc, body, t) {
  const b = body && typeof body === 'object' ? body : {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > NAME_MAX) return { status: 400, json: { ok: false, code: 'invalid_name', detail: null, error: t('error.invalid_name') } };
  if (!gc.edge) return { status: 409, json: { ok: false, code: 'unavailable', detail: null, error: t('error.unavailable') } };
  try {
    const result = await gc.edge.call(Number(b.gatewayId), 'greet', { name }, { timeoutMs: CALL_TIMEOUT_MS });
    return { json: { ok: true, result } };
  } catch (e) {
    return { status: 502, json: callError(e, t) };
  }
}

module.exports = { setup, configure, configureAll, list, greet, callError, heartbeats, NAME_MAX };
