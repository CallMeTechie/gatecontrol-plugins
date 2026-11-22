'use strict';

// Logic chains (port of GateControl's src/services/smarthome/smarthomeRules.js):
// a rule definition is translated into deCONZ objects (rules, schedules,
// CLIP flags) that run ON the gateway; this database keeps the definition and
// the ids of the objects created. Labels "GC:<rule id>:<name>" mark them.
//
// Since 1.10.0 a rule has a source: 'deconz' (as before, gateway_id = a deCONZ gateway of this plugin) or 'edge' —
// Shelly and Tasmota devices behind a GateControl gateway (gateway_id = that gateway). An edge rule has no deCONZ
// objects: server/edgerules.js compiles it and the plugin's edge part on the gateway runs it (edge/rules.js).
// Since 1.11.0 an edge rule may be a version 2 definition (WENN · NUR WENN · DANN, server/edgerules.js); deCONZ
// rules stay version 1. An edge rule the brake stopped carries stopped { at, reason } until it is started again.
// Since 1.12.0 a third source: 'server' (gateway_id 0) — a version 2 chain with devices of several gateways or of
// deCONZ, run by the server part (server/serverchains.js). A version 2 chain with the trigger "Von Hand (App)" is a
// quick action of the apps; quick_users (migrations/005_chain_quick.sql) are the portal viewers an administrator
// released it for.
// Since 1.15.0 a gateway's chain may use zigbee2mqtt devices of that gateway (server/edgerules.js): saving one asks for
// the optional capability zigbee2mqtt/# when it is not confirmed yet; rule.z2m 'approval' | 'unavailable' | null and
// rule.z2m_link (where an administrator confirms it) tell the page why such a chain does not run.

const store = require('./store');
const service = require('./service');
const translate = require('./translate');
const caps = require('./caps');
const edge = require('./edge');
const edgerules = require('./edgerules');
const { codeError } = require('./deconz');

const isChain = (source) => source === 'edge' || source === 'server';
const serverchains = () => require('./serverchains');

/** The chains of a place changed: the gateway's edge part, or the server's engine, gets the new list. */
async function pushPlace(gc, source, gatewayId) {
  if (source === 'server') return serverchains().reload(gc);
  return edge.configureGateway(gc, gatewayId);
}

/** The portal viewers a chain is released for (rules.quick_users, a JSON array). */
function quickUsersOf(row) {
  try {
    const v = JSON.parse(row && row.quick_users);
    return Array.isArray(v) ? v.filter((x) => Number.isSafeInteger(x) && x > 0) : [];
  } catch { return []; }
}

/** quick_users of a request: an array of user ids (at most 200), or null. */
function cleanQuickUsers(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!Array.isArray(v) || v.length > 200 || !v.every((x) => Number.isSafeInteger(x) && x > 0)) throw invalid('quick_users');
  return [...new Set(v)];
}

const LIMIT_CODES = new Set(caps.ruleLimit.errorCodes); // HTTP status AND 200-body error codes
function isLimit(e) { return !!(e && LIMIT_CODES.has(e.code)); }
function ruleLimitError() { return codeError('DECONZ_RULE_LIMIT_REACHED', 'deconz rule limit reached'); }
function limitWarn(gcRuleCount) { return gcRuleCount >= caps.ruleLimit.warnAtGcRules; }

function invalid(detail, msg) { return Object.assign(codeError('SMARTHOME_RULE_INVALID', msg || 'rule invalid'), { detail }); }

let clientFactory = async (gc, gatewayId) => service.clientForGateway(gc, await store.getGateway(gc, gatewayId));
function _setClientFactoryForTest(fn) { clientFactory = fn; }

async function resolverFor(gc, gatewayId) {
  const byId = new Map((await store.listResources(gc, gatewayId)).map((r) => [r.id, r]));
  return (resourceId) => {
    const r = byId.get(Number(resourceId));
    if (!r || r.gateway_id !== gatewayId) throw invalid('foreign_resource', 'resource not in gateway');
    return r;
  };
}

function parseRow(row) {
  if (!row) return null;
  return {
    id: row.id, gateway_id: row.gateway_id, name: row.name, enabled: !!row.enabled,
    definition: store.parseJson(row.definition_json),
    source: isChain(row.source) ? row.source : 'deconz', last_fired_at: row.last_fired_at || null,
    deconz_rule_id: row.deconz_rule_id, deconz_schedule_id: row.deconz_schedule_id, deconz_clip_sensor_id: row.deconz_clip_sensor_id,
    synced: isChain(row.source) || row.deconz_rule_id != null,
    stopped: isChain(row.source) && row.stopped_at ? { at: row.stopped_at, reason: row.stopped_reason || 'rate' } : null,
    quick_users: isChain(row.source) ? quickUsersOf(row) : undefined,
  };
}

function idsOf(def) {
  return [...((def && Array.isArray(def.triggers)) ? def.triggers : []).map((t) => t && t.resourceId),
    ...((def && Array.isArray(def.actions)) ? def.actions : []).map((a) => a && a.resourceId)].filter((x) => x != null);
}

async function list(gc, gatewayId, source = 'deconz') {
  if (isChain(source)) {
    const place = source === 'server' ? 0 : gatewayId;
    const byId = await edgerules.resourcesOf(gc, place);
    const devById = source === 'server' ? new Map() : await edgerules.devicesOf(gc, gatewayId);
    const today = await edgerules.runsToday(gc, place);
    const rows = source === 'server'
      ? (await gc.db.query("SELECT * FROM rules WHERE source = 'server' ORDER BY id")).rows
      : (await gc.db.query("SELECT * FROM rules WHERE source = 'edge' AND gateway_id = ? ORDER BY id", [gatewayId])).rows;
    const ids = new Set(rows.map((x) => x.id));
    let approved = null; // zigbee2mqtt/# on this gateway — asked once per list, only when a chain needs it
    const out = rows.map((row) => {
      const r = parseRow(row);
      const refs = edgerules.refsOf(r.definition);
      r.orphaned = !refs.resources.every((id) => byId.has(Number(id))) || !refs.devices.every((id) => devById.has(Number(id))) || !refs.chains.every((id) => ids.has(Number(id)));
      // the new editor edits version 2: a version 1 chain is shown as one ("wird wahr: A und B")
      r.v2 = edgerules.toV2(r.definition);
      r.runs_today = today.get(r.id) || 0;
      r.z2m = source === 'edge' && edgerules.usesZ2m(r.definition, byId) ? 'pending' : null;
      return r;
    });
    if (out.some((r) => r.z2m)) approved = await edgerules.z2mApproved(gc, gatewayId);
    for (const r of out) {
      if (!r.z2m) continue;
      r.z2m = edgerules.z2mStatus(gatewayId, approved);
      if (r.z2m) r.z2m_link = edgerules.z2mLink(gatewayId);
    }
    return out;
  }
  const resources = new Map((await store.listResources(gc, gatewayId)).map((r) => [r.id, r]));
  const rows = (await gc.db.query("SELECT * FROM rules WHERE source = 'deconz' AND gateway_id = ? ORDER BY id", [gatewayId])).rows;
  return rows.map((row) => {
    const r = parseRow(row);
    // a missing referenced device → read-only in the UI with a warning
    r.orphaned = !idsOf(r.definition).every((id) => { const x = resources.get(Number(id)); return x && x.gateway_id === gatewayId; });
    return r;
  });
}

async function get(gc, id) {
  return parseRow((await gc.db.get('SELECT * FROM rules WHERE id = ?', [Number(id)])).row);
}

function checkDefinition(def, source = 'deconz') {
  if (!def || typeof def !== 'object' || Array.isArray(def)) throw invalid('definition');
  if (def.triggers != null && !Array.isArray(def.triggers)) throw invalid('triggers');
  if (def.actions != null && !Array.isArray(def.actions)) throw invalid('actions');
  if ((def.triggers || []).length > 20 || (def.actions || []).length > 20) throw invalid('too_many');
  if (def.version === undefined) { if (source === 'server') throw invalid('bad_version'); return; }
  // version 2 (WENN · NUR WENN · DANN): the chains on a GateControl gateway and on the server
  if (def.version !== 2 || !isChain(source)) throw invalid('bad_version');
  if (def.steps != null && !Array.isArray(def.steps)) throw invalid('steps');
  if (def.conditions != null && (typeof def.conditions !== 'object' || Array.isArray(def.conditions) || (def.conditions.list != null && !Array.isArray(def.conditions.list)))) throw invalid('conditions');
  if ((def.steps || []).length > edgerules.MAX_STEPS) throw invalid('too_many_steps');
  if (((def.conditions && def.conditions.list) || []).length > 20) throw invalid('too_many');
}

function checkName(name, source = 'deconz') {
  // deCONZ rule names are ~32 characters including the GC:<id>: prefix; a chain on a GateControl gateway has 40
  if (!name || typeof name !== 'string' || name.length > (isChain(source) ? 40 : 20)) throw invalid('name_too_long', 'name too long');
}

/** Create the deCONZ objects of a plan; placeholders resolved; compensation on failure. */
async function materialize(client, objectPlan, apiKey) {
  const created = [];
  let scheduleId = null;
  let clipId = null;
  let ruleId = null;
  try {
    for (const obj of objectPlan.objects) {
      if (obj.type === 'clip') { clipId = await client.createClipSensor(obj.payload); created.push(['clip', clipId]); continue; }
      if (obj.type === 'schedule') {
        // schedule.command.address needs the /api/<apiKey> prefix (rule actions do not)
        const sp = JSON.parse(JSON.stringify(obj.payload));
        if (sp.command && typeof sp.command.address === 'string' && !sp.command.address.startsWith('/api/')) sp.command.address = `/api/${apiKey}${sp.command.address}`;
        scheduleId = await client.createSchedule(sp); created.push(['schedule', scheduleId]); continue;
      }
      const payload = JSON.parse(JSON.stringify(obj.payload));
      payload.actions = (payload.actions || []).map((a) => {
        if (a.address === '__schedule__') { if (!scheduleId) throw new Error('__schedule__ unresolved'); return { ...a, address: `/schedules/${scheduleId}` }; }
        if (a.address === '__clip_state__') { if (!clipId) throw new Error('__clip_state__ unresolved'); return { ...a, address: `/sensors/${clipId}/state` }; }
        return a;
      });
      const id = await client.createRule(payload);
      created.push(['rule', id]);
      if (obj.ref !== 'reset' && obj.ref !== 'cancel') ruleId = id; // primary trigger rule
    }
    return { ruleId, scheduleId, clipId };
  } catch (e) {
    for (const [kind, id] of created.reverse()) {
      try {
        if (kind === 'rule') await client.deleteRule(id);
        else if (kind === 'schedule') await client.deleteSchedule(id);
        else if (kind === 'clip' && caps.clipDeletable && client.deleteClipSensor) await client.deleteClipSensor(id);
      } catch { /* potential orphan; logged by the caller */ }
    }
    if (isLimit(e)) throw ruleLimitError();
    throw e;
  }
}

async function deleteObjects(gc, client, row) {
  for (const [m, did] of [['deleteRule', row.deconz_rule_id], ['deleteSchedule', row.deconz_schedule_id], ['deleteClipSensor', row.deconz_clip_sensor_id]]) {
    if (did && client[m]) {
      try { await client[m](did); } catch (e) { if (e.code !== 'DECONZ_HTTP_404') gc.log.warn('deconz object delete failed (potential orphan)', m, did, e.code || e.message); }
    }
  }
}

/**
 * A gateway's chain with zigbee2mqtt devices: zigbee2mqtt/# confirmed? If not, ask an administrator (GateControl notes it
 * at most once a day) → the rule with z2m 'approval' and the link, 'unavailable' (an older gateway) or null.
 */
async function withZ2m(gc, rule) {
  if (!rule || rule.source !== 'edge') return rule;
  const byId = await edgerules.resourcesOf(gc, rule.gateway_id);
  if (!edgerules.usesZ2m(rule.definition, byId)) return { ...rule, z2m: null };
  let approved = await edgerules.z2mApproved(gc, rule.gateway_id);
  if (!approved) approved = (await edgerules.z2mRequest(gc, rule.gateway_id)) === 'approved';
  const z2m = edgerules.z2mStatus(rule.gateway_id, approved);
  return { ...rule, z2m, ...(z2m ? { z2m_link: edgerules.z2mLink(rule.gateway_id) } : {}) };
}

/**
 * A chain (edge: on a GateControl gateway — stored, then the gateway's list goes to its edge part, now or when the
 * gateway is back; server: on the server — its engine takes the new list).
 */
async function createChain(gc, gatewayId, name, definition, source, quickUsers) {
  if (source === 'edge' && !edge.available(gc)) throw codeError('SMARTHOME_EDGE_UNAVAILABLE', 'no edge part');
  const place = source === 'server' ? 0 : gatewayId;
  await edgerules.check(gc, place, null, definition);
  const id = Number((await gc.db.run('INSERT INTO rules (gateway_id, name, enabled, definition_json, source, quick_users) VALUES (?, ?, 1, ?, ?, ?)',
    [place, name, JSON.stringify(definition), source, quickUsers && quickUsers.length ? JSON.stringify(quickUsers) : null])).lastInsertRowid);
  await pushPlace(gc, source, place);
  return withZ2m(gc, await get(gc, id));
}

async function create(gc, gatewayId, name, definition, source = 'deconz', { quickUsers } = {}) {
  checkName(name, source);
  checkDefinition(definition, source);
  if (isChain(source)) return createChain(gc, gatewayId, name, definition, source, cleanQuickUsers(quickUsers));
  const gw = await store.getGateway(gc, gatewayId);
  if (!gw) throw codeError('SMARTHOME_GATEWAY_NOT_FOUND', 'gateway not found');
  const resolve = await resolverFor(gc, gatewayId);
  const id = Number((await gc.db.run('INSERT INTO rules (gateway_id, name, enabled, definition_json) VALUES (?, ?, 1, ?)', [gatewayId, name, JSON.stringify(definition)])).lastInsertRowid);
  try {
    const plan = translate.buildRuleObjects(definition, resolve, `GC:${id}:${name}`);
    const { ruleId, scheduleId, clipId } = await materialize(await clientFactory(gc, gatewayId), plan, await store.apiKeyOf(gc, gatewayId));
    await gc.db.run('UPDATE rules SET deconz_rule_id = ?, deconz_schedule_id = ?, deconz_clip_sensor_id = ? WHERE id = ?', [ruleId, scheduleId, clipId, id]);
    return get(gc, id);
  } catch (e) {
    await gc.db.run('DELETE FROM rules WHERE id = ?', [id]);
    throw e;
  }
}

async function update(gc, id, name, definition, { quickUsers } = {}) {
  const row = await get(gc, id);
  if (!row) throw codeError('SMARTHOME_RULE_NOT_FOUND', 'rule not found');
  checkName(name, row.source);
  checkDefinition(definition, row.source);
  if (isChain(row.source)) {
    const qu = cleanQuickUsers(quickUsers);
    await edgerules.check(gc, row.gateway_id, row.id, definition);
    await gc.db.run("UPDATE rules SET name = ?, definition_json = ?, updated_at = datetime('now') WHERE id = ?", [name, JSON.stringify(definition), row.id]);
    if (qu !== undefined) await gc.db.run('UPDATE rules SET quick_users = ? WHERE id = ?', [qu && qu.length ? JSON.stringify(qu) : null, row.id]);
    await pushPlace(gc, row.source, row.gateway_id);
    return withZ2m(gc, await get(gc, row.id));
  }
  const client = await clientFactory(gc, row.gateway_id);
  const resolve = await resolverFor(gc, row.gateway_id);
  // NULL before delete: unlink ids, then remove the old objects (best effort)
  await gc.db.run('UPDATE rules SET deconz_rule_id = NULL, deconz_schedule_id = NULL, deconz_clip_sensor_id = NULL WHERE id = ?', [row.id]);
  await deleteObjects(gc, client, row);
  await gc.db.run("UPDATE rules SET name = ?, definition_json = ?, updated_at = datetime('now') WHERE id = ?", [name, JSON.stringify(definition), row.id]);
  try {
    const plan = translate.buildRuleObjects(definition, resolve, `GC:${row.id}:${name}`);
    const { ruleId, scheduleId, clipId } = await materialize(client, plan, await store.apiKeyOf(gc, row.gateway_id));
    await gc.db.run('UPDATE rules SET deconz_rule_id = ?, deconz_schedule_id = ?, deconz_clip_sensor_id = ? WHERE id = ?', [ruleId, scheduleId, clipId, row.id]);
    return get(gc, row.id);
  } catch (e) {
    // not synced + disabled → resyncPending skips it (no orphan cascade)
    await gc.db.run('UPDATE rules SET enabled = 0 WHERE id = ?', [row.id]);
    throw e;
  }
}

async function remove(gc, id) {
  const row = await get(gc, id);
  if (!row) return;
  if (isChain(row.source)) {
    await gc.db.run('DELETE FROM rules WHERE id = ?', [row.id]);
    await gc.db.run('DELETE FROM rule_runs WHERE rule_id = ?', [row.id]);
    await pushPlace(gc, row.source, row.gateway_id);
    return;
  }
  try { await deleteObjects(gc, await clientFactory(gc, row.gateway_id), row); } catch (e) { gc.log.warn('rule objects not removed from the gateway', e.code || e.message); }
  await gc.db.run('DELETE FROM rules WHERE id = ?', [row.id]);
}

async function setEnabled(gc, id, on) {
  const row = await get(gc, id);
  if (!row) throw codeError('SMARTHOME_RULE_NOT_FOUND', 'rule not found');
  if (isChain(row.source)) {
    // on again ("Wieder starten"): the stop of the brake is over
    if (on) await gc.db.run('UPDATE rules SET enabled = 1, stopped_at = NULL, stopped_reason = NULL, resumed_at = ? WHERE id = ?', [new Date().toISOString(), row.id]);
    else await gc.db.run('UPDATE rules SET enabled = 0 WHERE id = ?', [row.id]);
    await pushPlace(gc, row.source, row.gateway_id);
    return get(gc, row.id);
  }
  if (row.deconz_rule_id) {
    try { await (await clientFactory(gc, row.gateway_id)).updateRule(row.deconz_rule_id, { status: on ? 'enabled' : 'disabled' }); } catch { /* best effort */ }
  }
  await gc.db.run('UPDATE rules SET enabled = ? WHERE id = ?', [on ? 1 : 0, row.id]);
  return get(gc, row.id);
}

async function gatewayRuleCount(gc, gatewayId) {
  const rules = (await (await clientFactory(gc, gatewayId)).getRules()) || {};
  const all = rules && typeof rules === 'object' ? Object.values(rules) : [];
  // GC-owned objects carry the "GC:" name prefix (primary + #reset/#cancel rules)
  const gcCount = all.filter((r) => r && typeof r.name === 'string' && r.name.startsWith('GC:')).length;
  return { total_rules: all.length, gc_rules: gcCount, external_rules: Math.max(0, all.length - gcCount) };
}

/** Re-push rules that lost their deCONZ objects (e.g. the gateway was reset). */
async function resyncPending(gc) {
  const rows = (await gc.db.query("SELECT id FROM rules WHERE enabled = 1 AND deconz_rule_id IS NULL AND source = 'deconz'")).rows;
  for (const { id } of rows) {
    const row = await get(gc, id);
    try { await update(gc, id, row.name, row.definition); } catch { /* log-and-continue */ }
  }
  return rows.length;
}

module.exports = { list, get, create, update, remove, setEnabled, gatewayRuleCount, resyncPending, limitWarn, isChain, quickUsersOf, _setClientFactoryForTest };
