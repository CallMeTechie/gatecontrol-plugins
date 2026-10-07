'use strict';

// Data access of the plugin's own database (migrations/001_init.sql) —
// port of GateControl's smarthomeDevices.js / smarthomeOwners.js storage.
// The deCONZ API key of a gateway is a secret setting of the plugin
// (gc.settings.setSecret: encrypted with the server key by the host).

const { codeError } = require('./deconz');

const keyName = (gatewayId) => `gw.${Number(gatewayId)}.apikey`;

// One transaction at a time (BEGIN … COMMIT over the host's single
// connection to the plugin database); serialised in this process.
let txChain = Promise.resolve();
function tx(gc, fn) {
  const run = async () => {
    await gc.db.exec('BEGIN');
    try {
      const out = await fn();
      await gc.db.exec('COMMIT');
      return out;
    } catch (e) {
      await gc.db.exec('ROLLBACK').catch(() => {});
      throw e;
    }
  };
  const p = txChain.then(run, run);
  txChain = p.catch(() => {});
  return p;
}

function parseJson(s) {
  if (typeof s !== 'string' || !s) return {};
  try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

// ─── Gateways ───────────────────────────────────

function rowToGateway(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, target_index: row.target_index == null ? null : Number(row.target_index),
    enabled: row.enabled ? 1 : 0, last_seen_at: row.last_seen_at || null,
  };
}

async function getGateway(gc, id) {
  return rowToGateway((await gc.db.get('SELECT * FROM gateways WHERE id = ?', [Number(id)])).row);
}

async function listGateways(gc) {
  return (await gc.db.query('SELECT * FROM gateways ORDER BY id')).rows.map(rowToGateway);
}

async function apiKeyOf(gc, gatewayId) {
  const v = await gc.settings.get(keyName(gatewayId));
  return typeof v === 'string' && v ? v : null;
}

async function setApiKey(gc, gatewayId, apiKey) {
  await gc.settings.setSecret(keyName(gatewayId), apiKey || null);
}

async function createGateway(gc, { name, target_index = null, apiKey = null, enabled = true }) {
  const r = await gc.db.run('INSERT INTO gateways (name, target_index, enabled) VALUES (?, ?, ?)', [name, target_index, enabled ? 1 : 0]);
  if (apiKey) await setApiKey(gc, r.lastInsertRowid, apiKey);
  return getGateway(gc, r.lastInsertRowid);
}

async function updateGateway(gc, id, patch) {
  const sets = [];
  const vals = [];
  if ('name' in patch) { sets.push('name = ?'); vals.push(patch.name); }
  if ('target_index' in patch) { sets.push('target_index = ?'); vals.push(patch.target_index); }
  if ('enabled' in patch) { sets.push('enabled = ?'); vals.push(patch.enabled ? 1 : 0); }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    await gc.db.run(`UPDATE gateways SET ${sets.join(', ')} WHERE id = ?`, [...vals, Number(id)]);
  }
  if ('apiKey' in patch) await setApiKey(gc, id, patch.apiKey);
  return getGateway(gc, id);
}

async function touchGateway(gc, id) {
  await gc.db.run("UPDATE gateways SET last_seen_at = datetime('now') WHERE id = ?", [Number(id)]);
}

async function removeGateway(gc, id) {
  const gid = Number(id);
  await tx(gc, async () => {
    await gc.db.run('DELETE FROM resource_owners WHERE resource_id IN (SELECT id FROM resources WHERE gateway_id = ?)', [gid]);
    await gc.db.run('DELETE FROM rules WHERE gateway_id = ?', [gid]);
    await gc.db.run('DELETE FROM resources WHERE gateway_id = ?', [gid]);
    await gc.db.run('DELETE FROM gateways WHERE id = ?', [gid]);
  });
  await setApiKey(gc, gid, null);
  return { ok: true };
}

// ─── Resources ──────────────────────────────────

function rowToResource(row) {
  if (!row) return null;
  const { capabilities_json: caps, state_json: state, ...rest } = row;
  return { ...rest, capabilities: parseJson(caps), state: parseJson(state) };
}

async function listResources(gc, gatewayId) {
  const rows = gatewayId
    ? (await gc.db.query('SELECT * FROM resources WHERE gateway_id = ? ORDER BY kind, name', [Number(gatewayId)])).rows
    : (await gc.db.query('SELECT * FROM resources ORDER BY gateway_id, kind, name')).rows;
  return rows.map(rowToResource);
}

async function getResource(gc, id) {
  return rowToResource((await gc.db.get('SELECT * FROM resources WHERE id = ?', [Number(id)])).row);
}

async function upsertResource(gc, { gateway_id, deconz_id, deconz_type, uniqueid = null, kind, name, capabilities, state }) {
  // Lights/sensors match by stable uniqueid (survives Conbee id reassignment),
  // groups/scenes by deconz_id (no stable identifier).
  let existing = null;
  if (uniqueid && (deconz_type === 'lights' || deconz_type === 'sensors')) {
    existing = (await gc.db.get('SELECT id FROM resources WHERE gateway_id = ? AND uniqueid = ?', [gateway_id, uniqueid])).row;
  }
  if (!existing) {
    existing = (await gc.db.get('SELECT id FROM resources WHERE gateway_id = ? AND deconz_type = ? AND deconz_id = ?', [gateway_id, deconz_type, String(deconz_id)])).row;
  }
  const caps = JSON.stringify(capabilities || {});
  // state omitted → keep the cached state
  const stateJson = state === undefined ? undefined : JSON.stringify(state || {});
  if (existing) {
    if (stateJson === undefined) {
      await gc.db.run("UPDATE resources SET deconz_id = ?, uniqueid = ?, kind = ?, name = ?, capabilities_json = ?, enabled = 1, updated_at = datetime('now') WHERE id = ?",
        [String(deconz_id), uniqueid, kind, name, caps, existing.id]);
    } else {
      await gc.db.run("UPDATE resources SET deconz_id = ?, uniqueid = ?, kind = ?, name = ?, capabilities_json = ?, state_json = ?, enabled = 1, updated_at = datetime('now') WHERE id = ?",
        [String(deconz_id), uniqueid, kind, name, caps, stateJson, existing.id]);
    }
    return existing.id;
  }
  const r = await gc.db.run('INSERT INTO resources (gateway_id, deconz_id, deconz_type, uniqueid, kind, name, capabilities_json, state_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [gateway_id, String(deconz_id), deconz_type, uniqueid, kind, name, caps, stateJson === undefined ? null : stateJson]);
  return Number(r.lastInsertRowid);
}

/** seenKeys: `${deconz_type}:${deconz_id}`; resources not seen → enabled = 0. */
async function markMissing(gc, gatewayId, seenKeys) {
  const seen = new Set(seenKeys);
  const rows = (await gc.db.query('SELECT id, deconz_type, deconz_id FROM resources WHERE gateway_id = ?', [Number(gatewayId)])).rows;
  for (const r of rows) {
    if (!seen.has(`${r.deconz_type}:${r.deconz_id}`)) await gc.db.run("UPDATE resources SET enabled = 0, updated_at = datetime('now') WHERE id = ?", [r.id]);
  }
}

// ─── Owners (port of smarthomeOwners.js) ────────

const ASSIGNABLE = new Set(['light', 'plug', 'group', 'sensor']);

async function ownerIdsOf(gc, resourceId) {
  return (await gc.db.query('SELECT user_id FROM resource_owners WHERE resource_id = ? ORDER BY user_id', [Number(resourceId)])).rows.map((r) => r.user_id);
}

/** Validate before writing: resource exists and is assignable, every user exists; then replace the set. */
async function setOwners(gc, resourceId, userIds) {
  const r = (await gc.db.get('SELECT id, kind FROM resources WHERE id = ?', [Number(resourceId)])).row;
  if (!r) throw codeError('SMARTHOME_RESOURCE_NOT_FOUND', `resource ${resourceId} not found`);
  if (!ASSIGNABLE.has(r.kind)) throw codeError('SMARTHOME_NOT_ASSIGNABLE', `resource ${resourceId} not assignable`);
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length) {
    const known = new Set((await gc.users.list()).map((u) => u.id));
    for (const uid of ids) if (!known.has(uid)) throw codeError('SMARTHOME_OWNER_UNKNOWN_USER', `unknown user ${uid}`);
  }
  await tx(gc, async () => {
    await gc.db.run('DELETE FROM resource_owners WHERE resource_id = ?', [r.id]);
    for (const uid of ids) await gc.db.run('INSERT OR IGNORE INTO resource_owners (resource_id, user_id) VALUES (?, ?)', [r.id, uid]);
  });
  return ownerIdsOf(gc, r.id);
}

/** Directly owned resources + scenes whose group is owned (inheritance). */
async function resourcesOwnedBy(gc, userId) {
  const owned = (await gc.db.query('SELECT resource_id FROM resource_owners WHERE user_id = ?', [Number(userId)])).rows.map((r) => r.resource_id);
  if (!owned.length) return [];
  const out = new Set(owned);
  const groups = (await gc.db.query(`SELECT gateway_id, deconz_id FROM resources WHERE id IN (${owned.map(() => '?').join(',')}) AND kind = 'group'`, owned)).rows;
  for (const g of groups) {
    // scene deconz_id is '<groupDeconzId>/<sceneId>'; group ids are numbers → no LIKE wildcards
    const scenes = (await gc.db.query("SELECT id FROM resources WHERE gateway_id = ? AND kind = 'scene' AND enabled = 1 AND deconz_id LIKE ?", [g.gateway_id, `${g.deconz_id}/%`])).rows;
    for (const s of scenes) out.add(s.id);
  }
  return [...out];
}

/** Portal control gate: direct ownership or a scene of an owned group. */
async function canAccess(gc, resourceId, userId) {
  const r = (await gc.db.get('SELECT enabled FROM resources WHERE id = ?', [Number(resourceId)])).row;
  if (!r || !r.enabled) return false;
  return (await resourcesOwnedBy(gc, userId)).includes(Number(resourceId));
}

/** For a scene the owners shown (read-only) are its group's owners. */
async function inheritedOwnerIdsOf(gc, resource) {
  if (!resource || resource.kind !== 'scene') return [];
  const groupDeconzId = String(resource.deconz_id).split('/')[0];
  const grp = (await gc.db.get("SELECT id FROM resources WHERE gateway_id = ? AND kind = 'group' AND deconz_id = ?", [resource.gateway_id, groupDeconzId])).row;
  return grp ? ownerIdsOf(gc, grp.id) : [];
}

/** { resource_id: [user_id, …] } of every resource (one query). */
async function allOwners(gc) {
  const out = new Map();
  for (const r of (await gc.db.query('SELECT resource_id, user_id FROM resource_owners ORDER BY user_id')).rows) {
    if (!out.has(r.resource_id)) out.set(r.resource_id, []);
    out.get(r.resource_id).push(r.user_id);
  }
  return out;
}

module.exports = {
  tx, keyName, parseJson, getGateway, listGateways, apiKeyOf, setApiKey, createGateway, updateGateway, touchGateway, removeGateway,
  listResources, getResource, upsertResource, markMissing,
  ASSIGNABLE, ownerIdsOf, setOwners, resourcesOwnedBy, canAccess, inheritedOwnerIdsOf, allOwners,
};
