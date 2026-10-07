'use strict';

// Logic chains (port of GateControl's src/services/smarthome/smarthomeRules.js):
// a rule definition is translated into deCONZ objects (rules, schedules,
// CLIP flags) that run ON the gateway; this database keeps the definition and
// the ids of the objects created. Labels "GC:<rule id>:<name>" mark them.

const store = require('./store');
const service = require('./service');
const translate = require('./translate');
const caps = require('./caps');
const { codeError } = require('./deconz');

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
    deconz_rule_id: row.deconz_rule_id, deconz_schedule_id: row.deconz_schedule_id, deconz_clip_sensor_id: row.deconz_clip_sensor_id,
    synced: row.deconz_rule_id != null,
  };
}

function idsOf(def) {
  return [...((def && Array.isArray(def.triggers)) ? def.triggers : []).map((t) => t && t.resourceId),
    ...((def && Array.isArray(def.actions)) ? def.actions : []).map((a) => a && a.resourceId)].filter((x) => x != null);
}

async function list(gc, gatewayId) {
  const resources = new Map((await store.listResources(gc, gatewayId)).map((r) => [r.id, r]));
  const rows = (await gc.db.query('SELECT * FROM rules WHERE gateway_id = ? ORDER BY id', [gatewayId])).rows;
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

function checkDefinition(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) throw invalid('definition');
  if (def.triggers != null && !Array.isArray(def.triggers)) throw invalid('triggers');
  if (def.actions != null && !Array.isArray(def.actions)) throw invalid('actions');
  if ((def.triggers || []).length > 20 || (def.actions || []).length > 20) throw invalid('too_many');
}

function checkName(name) {
  // deCONZ rule names are ~32 characters including the GC:<id>: prefix
  if (!name || typeof name !== 'string' || name.length > 20) throw invalid('name_too_long', 'name too long');
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

async function create(gc, gatewayId, name, definition) {
  checkName(name);
  checkDefinition(definition);
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

async function update(gc, id, name, definition) {
  checkName(name);
  checkDefinition(definition);
  const row = await get(gc, id);
  if (!row) throw codeError('SMARTHOME_RULE_NOT_FOUND', 'rule not found');
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
  try { await deleteObjects(gc, await clientFactory(gc, row.gateway_id), row); } catch (e) { gc.log.warn('rule objects not removed from the gateway', e.code || e.message); }
  await gc.db.run('DELETE FROM rules WHERE id = ?', [row.id]);
}

async function setEnabled(gc, id, on) {
  const row = await get(gc, id);
  if (!row) throw codeError('SMARTHOME_RULE_NOT_FOUND', 'rule not found');
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
  const rows = (await gc.db.query('SELECT id FROM rules WHERE enabled = 1 AND deconz_rule_id IS NULL')).rows;
  for (const { id } of rows) {
    const row = await get(gc, id);
    try { await update(gc, id, row.name, row.definition); } catch { /* log-and-continue */ }
  }
  return rows.length;
}

module.exports = { list, get, create, update, remove, setEnabled, gatewayRuleCount, resyncPending, limitWarn, _setClientFactoryForTest };
