'use strict';

// Gateways and devices (port of GateControl's src/services/smarthome/index.js):
// connect (acquire an API key), test, sync resources, control.

const store = require('./store');
const { createClient, briFromDeconz, validApiKey, codeError } = require('./deconz');

async function clientForGateway(gc, gw) {
  if (!gw) throw codeError('SMARTHOME_GATEWAY_NOT_FOUND', 'gateway not found');
  if (gw.target_index == null) throw codeError('SMARTHOME_NO_TARGET', 'gateway has no access target');
  const apiKey = await store.apiKeyOf(gc, gw.id);
  if (!apiKey) throw codeError('SMARTHOME_NO_API_KEY', 'gateway has no api key');
  return createClient(gc, { index: gw.target_index, apiKey });
}

function capsFromLight(light) {
  const s = light.state || {};
  let color = 'none';
  if ('xy' in s) color = 'xy';
  else if ('hue' in s || 'sat' in s) color = 'hs';
  else if ('ct' in s) color = 'ct';
  return { on: 'on' in s, bri: 'bri' in s, color };
}

function sensorReading(sensor) {
  const s = sensor.state || {};
  if ('presence' in s) return { type: 'presence', value: s.presence };
  if ('open' in s) return { type: 'open', value: s.open };
  if ('water' in s) return { type: 'water', value: s.water };
  if ('temperature' in s) return { type: 'temperature', value: s.temperature / 100 };
  if ('humidity' in s) return { type: 'humidity', value: s.humidity / 100 };
  if ('lightlevel' in s) return { type: 'lightlevel', value: s.lux != null ? s.lux : s.lightlevel };
  if ('buttonevent' in s) return { type: 'button', value: s.buttonevent };
  return { type: 'unknown', value: null };
}

// Normalised live state cached on each resource (bri 0-100).
function lightStateOf(light) {
  const s = light.state || {};
  const st = { on: !!s.on, reachable: s.reachable !== false };
  if ('bri' in s) st.bri = briFromDeconz(s.bri);
  return st;
}
function groupStateOf(group) {
  const s = group.state || {};
  return { on: !!s.any_on };
}

// deCONZ /lights also carries plugs and the virtual "Configuration tool" (null = skip).
function lightKind(light) {
  if ((light.type || '') === 'Configuration tool') return null;
  return /plug/i.test(light.type || '') ? 'plug' : 'light';
}

// deCONZ /sensors mixes sensors, button remotes (ZHASwitch) and virtuals (null = skip).
function sensorKind(sensor) {
  const t = sensor.type || '';
  if (t.startsWith('CLIP') || t === 'Daylight') return null;
  return /switch/i.test(t) ? 'switch' : 'sensor';
}

function entries(obj) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.entries(obj) : [];
}

/**
 * Connect a gateway: the given API key, or a new one from the gateway
 * (the administrator pressed "Authenticate app" in Phoscon before).
 */
async function connectGateway(gc, { name, target_index, apiKey }) {
  let key = apiKey || null;
  if (key && !validApiKey(key)) throw codeError('SMARTHOME_INVALID_KEY', 'invalid api key');
  if (!key) key = (await createClient(gc, { index: target_index }).acquireApiKey()).apiKey;
  return store.createGateway(gc, { name, target_index, apiKey: key, enabled: true });
}

async function syncGateway(gc, gatewayId) {
  const gw = await store.getGateway(gc, gatewayId);
  const client = await clientForGateway(gc, gw);
  const counts = { lights: 0, plugs: 0, groups: 0, scenes: 0, sensors: 0, switches: 0 };
  const seen = [];

  try {
    for (const [id, l] of entries(await client.getLights())) {
      const kind = lightKind(l);
      if (!kind) continue;
      await store.upsertResource(gc, { gateway_id: gw.id, deconz_id: id, deconz_type: 'lights', uniqueid: l.uniqueid || null, kind, name: l.name, capabilities: capsFromLight(l), state: lightStateOf(l) });
      seen.push(`lights:${id}`); counts[kind === 'plug' ? 'plugs' : 'lights']++;
    }
  } catch { /* best effort */ }

  try {
    for (const [id, g] of entries(await client.getGroups())) {
      await store.upsertResource(gc, { gateway_id: gw.id, deconz_id: id, deconz_type: 'groups', kind: 'group', name: g.name, capabilities: { on: true, bri: true, color: 'hs' }, state: groupStateOf(g) });
      seen.push(`groups:${id}`); counts.groups++;
      for (const sc of (Array.isArray(g.scenes) ? g.scenes : [])) {
        const sceneKey = `${id}/${sc.id}`;
        await store.upsertResource(gc, { gateway_id: gw.id, deconz_id: sceneKey, deconz_type: 'scenes', kind: 'scene', name: `${g.name} · ${sc.name}`, capabilities: { group_id: id, scene_id: sc.id } });
        seen.push(`scenes:${sceneKey}`); counts.scenes++;
      }
    }
  } catch { /* best effort */ }

  try {
    for (const [id, s] of entries(await client.getSensors())) {
      const kind = sensorKind(s);
      if (!kind) continue;
      const rd = sensorReading(s);
      await store.upsertResource(gc, { gateway_id: gw.id, deconz_id: id, deconz_type: 'sensors', uniqueid: s.uniqueid || null, kind, name: s.name, capabilities: { reading: rd.type }, state: rd });
      seen.push(`sensors:${id}`); counts[kind === 'switch' ? 'switches' : 'sensors']++;
    }
  } catch { /* best effort */ }

  if (seen.length) { await store.markMissing(gc, gw.id, seen); await store.touchGateway(gc, gw.id); }
  return { counts };
}

function validatePatch(resource, raw) {
  const caps = resource.capabilities || {};
  const patch = {};
  if ('on' in raw) patch.on = Boolean(raw.on);
  if ('bri' in raw && caps.bri) { const b = Number(raw.bri); if (Number.isFinite(b)) patch.bri = Math.max(0, Math.min(100, b)); }
  if (caps.color === 'ct' && 'ct' in raw && Number.isFinite(Number(raw.ct))) patch.ct = Number(raw.ct);
  if (caps.color === 'hs') {
    if ('hue' in raw && Number.isFinite(Number(raw.hue))) patch.hue = Number(raw.hue);
    if ('sat' in raw && Number.isFinite(Number(raw.sat))) patch.sat = Number(raw.sat);
  }
  if (caps.color === 'xy' && Array.isArray(raw.xy) && raw.xy.length === 2 && raw.xy.every((n) => Number.isFinite(Number(n)))) patch.xy = raw.xy.map(Number);
  return patch;
}

/** Control a resource; the cached state follows what was sent (the next sync corrects it). */
async function setResourceState(gc, resourceId, raw) {
  const resource = await store.getResource(gc, resourceId);
  if (!resource) throw codeError('SMARTHOME_RESOURCE_NOT_FOUND', `resource ${resourceId} not found`);
  const client = await clientForGateway(gc, await store.getGateway(gc, resource.gateway_id));
  if (resource.kind === 'scene') {
    const [groupId, sceneId] = String(resource.deconz_id).split('/');
    return client.recallScene(groupId, sceneId);
  }
  if (resource.kind === 'sensor' || resource.kind === 'switch') throw codeError('SMARTHOME_NOT_CONTROLLABLE', `resource ${resourceId} is not controllable`);
  const patch = validatePatch(resource, raw && typeof raw === 'object' ? raw : {});
  const out = resource.kind === 'group' ? await client.setGroupState(resource.deconz_id, patch) : await client.setLightState(resource.deconz_id, patch);
  const st = { ...(resource.state || {}) };
  if ('on' in patch) st.on = patch.on;
  if ('bri' in patch) st.bri = Math.round(patch.bri);
  await gc.db.run("UPDATE resources SET state_json = ?, updated_at = datetime('now') WHERE id = ?", [JSON.stringify(st), resource.id]);
  return out;
}

/** Reachability probe — "unreachable" is a result, not an error. */
async function testGateway(gc, gatewayId) {
  const gw = await store.getGateway(gc, gatewayId);
  if (!gw) throw codeError('SMARTHOME_GATEWAY_NOT_FOUND', 'gateway not found');
  if (gw.target_index == null) throw codeError('SMARTHOME_NO_TARGET', 'gateway has no access target');
  const target = await targetLabel(gc, gw.target_index);
  try {
    const client = createClient(gc, { index: gw.target_index, apiKey: await store.apiKeyOf(gc, gw.id) });
    const config = (await client.getConfig()) || {};
    return { reachable: true, target, config: { name: config.name, swversion: config.swversion, apiversion: config.apiversion } };
  } catch (err) {
    return { reachable: false, target, code: err.code || 'DECONZ_UNREACHABLE' };
  }
}

/** Assigned gateway targets: [{ index, label }]. */
async function gatewayTargets(gc) {
  try {
    const t = (await gc.net.targets()).find((x) => x.id === 'gateway');
    return t ? t.assigned : [];
  } catch { return []; }
}

async function targetLabel(gc, index) {
  const t = (await gatewayTargets(gc)).find((a) => a.index === index);
  return t ? t.label : null;
}

/** Background sync of every enabled gateway (best effort). */
async function syncAll(gc) {
  for (const gw of await store.listGateways(gc)) {
    if (!gw.enabled) continue;
    try { await syncGateway(gc, gw.id); } catch (e) { gc.log.debug('gateway sync failed', gw.id, e.code || e.message); }
  }
}

module.exports = {
  connectGateway, syncGateway, setResourceState, testGateway, gatewayTargets, targetLabel, syncAll, clientForGateway,
  capsFromLight, sensorReading, lightKind, sensorKind, validatePatch,
};
