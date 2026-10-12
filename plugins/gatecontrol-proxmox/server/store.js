'use strict';

// Data access of the plugin's own database (migrations/001_init.sql).
// The API token secret of a connection is a plugin secret
// (gc.settings.setSecret 'host.<id>.secret'): encrypted by the host, never
// sent to the browser, never in this database, never logged.

function codeError(code) { return Object.assign(new Error(code), { code }); }

const MAX_ACTIONS = 300;
const MAX_SNAPSHOT_CHARS = 900 * 1024; // the host takes a string parameter of at most 1 MB

// ─── Hosts ──────────────────────────────────────

const HOST_COLS = 'id, name, target_index, token_id, enabled, status, last_error, error_count, last_attempt_at, last_success_at, next_poll_at, pve_version, cluster_name, created_at, updated_at';

function hostRow(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, target_index: r.target_index == null ? null : Number(r.target_index), token_id: r.token_id, enabled: !!r.enabled,
    status: r.status, last_error: r.last_error || null, error_count: Number(r.error_count) || 0,
    last_attempt_at: r.last_attempt_at == null ? null : Number(r.last_attempt_at), last_success_at: r.last_success_at == null ? null : Number(r.last_success_at),
    next_poll_at: Number(r.next_poll_at) || 0, pve_version: r.pve_version || null, cluster_name: r.cluster_name || null,
  };
}

async function listHosts(gc) {
  return (await gc.db.query(`SELECT ${HOST_COLS} FROM hosts ORDER BY name COLLATE NOCASE, id`)).rows.map(hostRow);
}

async function getHost(gc, id) {
  return hostRow((await gc.db.get(`SELECT ${HOST_COLS} FROM hosts WHERE id = ?`, [id])).row);
}

async function createHost(gc, { name, target_index, token_id, enabled = true }) {
  const r = await gc.db.run('INSERT INTO hosts (name, target_index, token_id, enabled) VALUES (?, ?, ?, ?)', [name, target_index, token_id, enabled ? 1 : 0]);
  return getHost(gc, r.lastInsertRowid);
}

const UPDATABLE = ['name', 'target_index', 'token_id', 'enabled', 'status', 'last_error', 'error_count', 'last_attempt_at', 'last_success_at', 'next_poll_at', 'pve_version', 'cluster_name'];

async function updateHost(gc, id, patch) {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.includes(k));
  if (keys.length) {
    const vals = keys.map((k) => (typeof patch[k] === 'boolean' ? (patch[k] ? 1 : 0) : patch[k]));
    await gc.db.run(`UPDATE hosts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...vals, id]);
  }
  return getHost(gc, id);
}

async function removeHost(gc, id) {
  await gc.db.run('DELETE FROM watched_guests WHERE host_id = ?', [id]);
  await gc.db.run('DELETE FROM snapshots WHERE host_id = ?', [id]);
  await gc.db.run('DELETE FROM actions WHERE host_id = ?', [id]);
  await gc.db.run('DELETE FROM hosts WHERE id = ?', [id]);
  await setSecret(gc, id, null);
}

// ─── Token secret ───────────────────────────────

const secretKey = (id) => `host.${id}.secret`;

async function secretOf(gc, id) {
  try {
    const v = await gc.settings.get(secretKey(id));
    return typeof v === 'string' && v ? v : null;
  } catch { return null; }
}

async function setSecret(gc, id, value) {
  await gc.settings.setSecret(secretKey(id), value == null || value === '' ? null : String(value));
}

// ─── Watched guests ─────────────────────────────

async function watchedOf(gc, hostId) {
  return (await gc.db.query('SELECT vmid FROM watched_guests WHERE host_id = ? ORDER BY vmid', [hostId])).rows.map((r) => Number(r.vmid));
}

async function setWatched(gc, hostId, vmid, on) {
  if (on) await gc.db.run('INSERT OR IGNORE INTO watched_guests (host_id, vmid) VALUES (?, ?)', [hostId, vmid]);
  else await gc.db.run('DELETE FROM watched_guests WHERE host_id = ? AND vmid = ?', [hostId, vmid]);
  return watchedOf(gc, hostId);
}

// ─── Snapshot (last good status) ────────────────

async function snapshotOf(gc, hostId) {
  const r = (await gc.db.get('SELECT fetched_at, data FROM snapshots WHERE host_id = ?', [hostId])).row;
  if (!r) return null;
  try { return JSON.parse(r.data); } catch { return null; }
}

async function saveSnapshot(gc, hostId, snap) {
  let json = JSON.stringify(snap);
  if (json.length > MAX_SNAPSHOT_CHARS) {
    // a very large cluster: keep nodes, storages, backups and as many guests as fit
    const s = { ...snap, guests: snap.guests.slice(0, Math.max(0, Math.floor(snap.guests.length * (MAX_SNAPSHOT_CHARS / json.length) * 0.9))), truncated: true };
    json = JSON.stringify(s);
  }
  await gc.db.run('INSERT INTO snapshots (host_id, fetched_at, data) VALUES (?, ?, ?) ON CONFLICT(host_id) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data', [hostId, snap.at, json]);
}

// ─── Actions ────────────────────────────────────

const ACTION_COLS = 'id, host_id, node, guest_type, vmid, guest_name, action, upid, status, exitstatus, user_id, user_name, started_at, finished_at';

function actionRow(r) {
  if (!r) return null;
  return {
    id: r.id, host_id: r.host_id, node: r.node, guest_type: r.guest_type, vmid: Number(r.vmid), guest_name: r.guest_name || '', action: r.action,
    upid: r.upid || null, status: r.status, exitstatus: r.exitstatus || null, user_id: r.user_id == null ? null : Number(r.user_id), user_name: r.user_name || null,
    started_at: Number(r.started_at), finished_at: r.finished_at == null ? null : Number(r.finished_at),
  };
}

async function addAction(gc, a) {
  const r = await gc.db.run(`INSERT INTO actions (host_id, node, guest_type, vmid, guest_name, action, upid, status, user_id, user_name, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [a.host_id, a.node, a.guest_type, a.vmid, a.guest_name || null, a.action, a.upid || null, a.status || 'running', a.user_id ?? null, a.user_name || null, a.started_at]);
  // keep the log short
  await gc.db.run(`DELETE FROM actions WHERE id NOT IN (SELECT id FROM actions ORDER BY id DESC LIMIT ${MAX_ACTIONS})`);
  return getAction(gc, r.lastInsertRowid);
}

async function getAction(gc, id) {
  return actionRow((await gc.db.get(`SELECT ${ACTION_COLS} FROM actions WHERE id = ?`, [id])).row);
}

async function finishAction(gc, id, { status, exitstatus, finished_at }) {
  await gc.db.run('UPDATE actions SET status = ?, exitstatus = ?, finished_at = ? WHERE id = ?', [status, exitstatus == null ? null : String(exitstatus).slice(0, 200), finished_at, id]);
  return getAction(gc, id);
}

async function recentActions(gc, limit = 20) {
  return (await gc.db.query(`SELECT ${ACTION_COLS} FROM actions ORDER BY id DESC LIMIT ?`, [limit])).rows.map(actionRow);
}

async function runningActions(gc) {
  return (await gc.db.query(`SELECT ${ACTION_COLS} FROM actions WHERE status = 'running' ORDER BY id`)).rows.map(actionRow);
}

/** The latest action per guest of a host since `since` (ms): Map vmid → action. */
async function latestActions(gc, hostId, since) {
  const rows = (await gc.db.query(`SELECT ${ACTION_COLS} FROM actions WHERE host_id = ? AND started_at >= ? ORDER BY id`, [hostId, since])).rows.map(actionRow);
  const out = new Map();
  for (const a of rows) out.set(a.vmid, a);
  return out;
}

module.exports = {
  listHosts, getHost, createHost, updateHost, removeHost, secretOf, setSecret, secretKey,
  watchedOf, setWatched, snapshotOf, saveSnapshot,
  addAction, getAction, finishAction, recentActions, runningActions, latestActions,
  codeError, MAX_ACTIONS,
};
