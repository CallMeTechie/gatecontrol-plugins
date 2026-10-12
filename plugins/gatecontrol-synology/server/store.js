'use strict';

// Data access of the plugin's own database (migrations/001_init.sql) and
// the secrets of a NAS. The DSM account and device token are plugin
// secrets (gc.settings.setSecret 'nas.<id>.user' / '.password' /
// '.device'): encrypted by the host, carried by backups, never sent to the
// browser, never in this database.

const SECRET_KINDS = ['user', 'password', 'device'];

function parseJson(s, fallback) {
  if (typeof s !== 'string' || !s) return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
}

const COLS = `id, name, target_index, target_label, enabled, status, last_error, error_count, last_attempt_at, last_success_at,
  next_poll_at, update_checked_at, power_state, power_at, created_at, updated_at`;

function nasRow(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, target_index: Number(r.target_index), target_label: r.target_label || null, enabled: !!r.enabled,
    status: r.status || 'new', last_error: r.last_error || null, error_count: Number(r.error_count) || 0,
    last_attempt_at: r.last_attempt_at == null ? null : Number(r.last_attempt_at),
    last_success_at: r.last_success_at == null ? null : Number(r.last_success_at),
    next_poll_at: Number(r.next_poll_at) || 0,
    update_checked_at: r.update_checked_at == null ? null : Number(r.update_checked_at),
    power_state: r.power_state || null, power_at: r.power_at == null ? null : Number(r.power_at),
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

async function listNas(gc) {
  const { rows } = await gc.db.query(`SELECT ${COLS} FROM nas ORDER BY name COLLATE NOCASE, id`);
  return rows.map(nasRow);
}

async function getNas(gc, id) {
  const { row } = await gc.db.get(`SELECT ${COLS} FROM nas WHERE id = ?`, [id]);
  return nasRow(row);
}

async function createNas(gc, f) {
  const r = await gc.db.run('INSERT INTO nas (name, target_index, target_label, enabled) VALUES (?, ?, ?, ?)',
    [f.name, f.target_index, f.target_label || null, f.enabled === false ? 0 : 1]);
  return getNas(gc, r.lastInsertRowid);
}

const UPDATABLE = ['name', 'target_index', 'target_label', 'enabled', 'status', 'last_error', 'error_count', 'last_attempt_at', 'last_success_at',
  'next_poll_at', 'update_checked_at', 'power_state', 'power_at'];

async function updateNas(gc, id, patch) {
  const sets = [];
  const params = [];
  for (const k of UPDATABLE) {
    if (patch[k] === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(typeof patch[k] === 'boolean' ? (patch[k] ? 1 : 0) : patch[k]);
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    await gc.db.run(`UPDATE nas SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  }
  return getNas(gc, id);
}

async function deleteNas(gc, id) {
  await gc.db.run('DELETE FROM snapshots WHERE nas_id = ?', [id]);
  const r = await gc.db.run('DELETE FROM nas WHERE id = ?', [id]);
  for (const k of SECRET_KINDS) await setSecret(gc, id, k, null);
  return r.changes > 0;
}

// ─── Snapshots (last good status) ───────────────

async function getSnapshot(gc, id) {
  const { row } = await gc.db.get('SELECT data, fetched_at FROM snapshots WHERE nas_id = ?', [id]);
  return row ? { data: parseJson(row.data, null), fetched_at: Number(row.fetched_at) } : null;
}

async function allSnapshots(gc) {
  const { rows } = await gc.db.query('SELECT nas_id, data, fetched_at FROM snapshots');
  return new Map(rows.map((r) => [r.nas_id, { data: parseJson(r.data, null), fetched_at: Number(r.fetched_at) }]));
}

async function saveSnapshot(gc, id, data, at) {
  await gc.db.run('INSERT INTO snapshots (nas_id, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(nas_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at',
    [id, JSON.stringify(data), at]);
}

// ─── Secrets ────────────────────────────────────

const secretKey = (id, kind) => `nas.${Number(id)}.${kind}`;

async function secret(gc, id, kind) {
  try {
    const v = await gc.settings.get(secretKey(id, kind));
    return typeof v === 'string' && v ? v : null;
  } catch { return null; }
}

async function setSecret(gc, id, kind, value) {
  if (!SECRET_KINDS.includes(kind)) throw new Error('unknown secret');
  await gc.settings.setSecret(secretKey(id, kind), value == null || value === '' ? null : String(value));
}

/** { account, password, device } of a NAS (for the DSM login only). */
async function credentials(gc, id) {
  return { account: await secret(gc, id, 'user'), password: await secret(gc, id, 'password'), device: await secret(gc, id, 'device') };
}

module.exports = {
  listNas, getNas, createNas, updateNas, deleteNas, getSnapshot, allSnapshots, saveSnapshot,
  secret, setSecret, credentials, secretKey, SECRET_KINDS,
};
