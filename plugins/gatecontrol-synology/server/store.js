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

// ─── Writes kept in memory (1.2.2, 1.2.3) ───────
// 1.2.2 stored the whole snapshot and the poll times of the NAS every 5 minutes: 240–288 of each a day and NAS, the
// snapshot upsert up to 5 s on a slow disk (GateControl's protocol of 12./13. 11.). Almost all of it was the live
// values (CPU, memory, temperatures, uptime, bytes used) — the rest of a status changes a few times a day at most.
// 1.2.3: the newest snapshot and poll times are kept here and read first (the page, the apps and the notifications
// see every poll as before). The snapshot is stored
//   * at once when anything but the live values changed (see steadyOf: model, DSM, status of volumes / pools /
//     drives, backups, update, UPS state, what the page flags — `marks`, the issues by the thresholds of the
//     settings — or a volume / pool filling by a whole point), and
//   * otherwise every PERSIST_MS (the live values of the stored one are at most that old), and
//   * when the plugin stops (flush).
// The poll times alone (last_attempt_at, last_success_at, next_poll_at) are never a reason to write: they go along
// with the next write of the row (status, error, power, update check — the check alone is every 6 h) and with flush.
// After a restart the stored snapshot stands with its own time (fetched_at, never newer than it is) until the next
// poll — which is due at once, the stored next_poll_at being in the past; lastSuccess() reads the time of the last
// good poll from both.
const PERSIST_MS = 60 * 60000;
const PCT_STEP = 1;
const VOLATILE = new Set(['last_attempt_at', 'last_success_at', 'next_poll_at']);
// gc → { snaps: Map(nas id → { snap: { data, fetched_at }, saved: data as stored, key, savedAt, dirty }), nas: Map(nas id → { patch }) }
const memBy = new WeakMap();
function memOf(gc) {
  let m = memBy.get(gc);
  if (!m) { m = { snaps: new Map(), nas: new Map() }; memBy.set(gc, m); }
  return m;
}
function overlay(gc, n) {
  const e = n && memOf(gc).nas.get(n.id);
  return e && e.patch ? { ...n, ...e.patch } : n;
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
  return rows.map((r) => overlay(gc, nasRow(r)));
}

async function getNas(gc, id) {
  const { row } = await gc.db.get(`SELECT ${COLS} FROM nas WHERE id = ?`, [id]);
  return overlay(gc, nasRow(row));
}

async function createNas(gc, f) {
  const r = await gc.db.run('INSERT INTO nas (name, target_index, target_label, enabled) VALUES (?, ?, ?, ?)',
    [f.name, f.target_index, f.target_label || null, f.enabled === false ? 0 : 1]);
  return getNas(gc, r.lastInsertRowid);
}

const UPDATABLE = ['name', 'target_index', 'target_label', 'enabled', 'status', 'last_error', 'error_count', 'last_attempt_at', 'last_success_at',
  'next_poll_at', 'update_checked_at', 'power_state', 'power_at'];

async function updateNas(gc, id, patch) {
  const keys = UPDATABLE.filter((k) => patch[k] !== undefined);
  const mem = memOf(gc).nas;
  const e = mem.get(id);
  if (keys.length) {
    const cur = await getNas(gc, id);
    const changed = cur ? keys.filter((k) => cur[k] !== patch[k]) : keys;
    if (!changed.length) return cur;
    if (cur && changed.every((k) => VOLATILE.has(k))) {
      mem.set(id, { patch: { ...((e && e.patch) || {}), ...Object.fromEntries(changed.map((k) => [k, patch[k]])) } });
      return getNas(gc, id);
    }
  }
  const all = { ...((e && e.patch) || {}), ...Object.fromEntries(keys.map((k) => [k, patch[k]])) };
  if (keys.length) await writeNas(gc, id, all);
  return getNas(gc, id);
}

async function writeNas(gc, id, all) {
  const sets = [];
  const params = [];
  for (const k of UPDATABLE) {
    if (all[k] === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(typeof all[k] === 'boolean' ? (all[k] ? 1 : 0) : all[k]);
  }
  if (!sets.length) return;
  memOf(gc).nas.delete(id);
  sets.push("updated_at = datetime('now')");
  await gc.db.run(`UPDATE nas SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

async function deleteNas(gc, id) {
  memOf(gc).nas.delete(id);
  memOf(gc).snaps.delete(id);
  await gc.db.run('DELETE FROM snapshots WHERE nas_id = ?', [id]);
  await gc.db.run('DELETE FROM drop_folders WHERE nas_id = ?', [id]);
  const r = await gc.db.run('DELETE FROM nas WHERE id = ?', [id]);
  for (const k of SECRET_KINDS) await setSecret(gc, id, k, null);
  return r.changes > 0;
}

// ─── Snapshots (last good status) ───────────────

const rowSnap = (row) => (row ? { data: parseJson(row.data, null), fetched_at: Number(row.fetched_at) } : null);

async function getSnapshot(gc, id) {
  const kept = memOf(gc).snaps.get(id);
  if (kept) return kept.snap;
  const { row } = await gc.db.get('SELECT data, fetched_at FROM snapshots WHERE nas_id = ?', [id]);
  return rowSnap(row);
}

async function allSnapshots(gc) {
  const { rows } = await gc.db.query('SELECT nas_id, data, fetched_at FROM snapshots');
  const out = new Map(rows.map((r) => [r.nas_id, rowSnap(r)]));
  for (const [id, kept] of memOf(gc).snaps) out.set(id, kept.snap);
  return out;
}

/**
 * A status without its live values, as text: what is left changes rarely (a few times a day at most). Left out:
 * uptime and system temperature, CPU / RAM, bytes used and the fill level of volumes and pools (see moved), drive
 * temperatures, charge and runtime of the UPS, and whether this poll looked for a DSM update. `marks`: what the
 * caller derives from the live values and wants stored with them (the issues by the thresholds of the settings).
 */
function steadyOf(data, marks) {
  const d = data && typeof data === 'object' ? data : {};
  const sized = (x) => ({ ...x, used: undefined, pct: undefined });
  const arr = (v) => (Array.isArray(v) ? v : []);
  return JSON.stringify({
    ...d, update_checked: undefined, util: undefined,
    info: d.info ? { ...d.info, uptime_s: undefined, temp: undefined } : null,
    volumes: arr(d.volumes).map(sized), pools: arr(d.pools).map(sized),
    disks: arr(d.disks).map((x) => ({ ...x, temp: undefined })),
    ups: d.ups ? { ...d.ups, charge: undefined, runtime_s: undefined } : null,
    marks: marks == null ? null : marks,
  });
}

/** Did a volume or pool fill (or empty) by PCT_STEP points since the stored status? (same lists: steadyOf was equal) */
function moved(saved, data) {
  for (const k of ['volumes', 'pools']) {
    const a = (saved && saved[k]) || [];
    const b = (data && data[k]) || [];
    for (let i = 0; i < b.length; i++) {
      const x = a[i] ? a[i].pct : null;
      const y = b[i].pct;
      if ((x == null) !== (y == null) || (x != null && Math.abs(x - y) >= PCT_STEP)) return true;
    }
  }
  return false;
}

/**
 * Keep the status of a poll (read first from now on) and store it when it is due (see the top of this file).
 * marksOf(data): see steadyOf. → true when it was written
 */
async function saveSnapshot(gc, id, data, at, { marksOf = null } = {}) {
  const snaps = memOf(gc).snaps;
  const keyOf = (d) => steadyOf(d, marksOf ? marksOf(d) : null);
  let kept = snaps.get(id);
  if (!kept) {
    // the first poll after a start: compare with what is stored
    const { row } = await gc.db.get('SELECT data, fetched_at FROM snapshots WHERE nas_id = ?', [id]);
    const stored = rowSnap(row);
    if (stored && stored.data) kept = { snap: stored, saved: stored.data, key: keyOf(stored.data), savedAt: stored.fetched_at, dirty: false };
  }
  // a copy as read back from the database would be (the caller may change `data` afterwards)
  const snap = { data: JSON.parse(JSON.stringify(data)), fetched_at: Number(at) };
  const key = keyOf(snap.data);
  if (kept && kept.key === key && !moved(kept.saved, snap.data) && at - kept.savedAt < PERSIST_MS && at >= kept.savedAt) {
    snaps.set(id, { ...kept, snap, dirty: true });
    return false;
  }
  snaps.set(id, { snap, saved: snap.data, key, savedAt: snap.fetched_at, dirty: false });
  try { await writeSnapshot(gc, id, snap); } catch (e) {
    // not stored: the next poll tries again (the newest stays readable from memory)
    snaps.set(id, { snap, saved: kept ? kept.saved : null, key: null, savedAt: kept ? kept.savedAt : 0, dirty: true });
    throw e;
  }
  return true;
}

function writeSnapshot(gc, id, snap) {
  return gc.db.run('INSERT INTO snapshots (nas_id, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(nas_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at',
    [id, JSON.stringify(snap.data), snap.fetched_at]);
}

/** Store what is only kept in memory (the plugin stops): the newest snapshots and poll times. → number of writes */
async function flush(gc) {
  const m = memOf(gc);
  let n = 0;
  for (const [id, kept] of m.snaps) {
    if (!kept.dirty) continue;
    m.snaps.set(id, { ...kept, saved: kept.snap.data, savedAt: kept.snap.fetched_at, dirty: false });
    await writeSnapshot(gc, id, kept.snap);
    n++;
  }
  for (const [id, e] of [...m.nas]) {
    if (!e.patch) continue;
    await writeNas(gc, id, e.patch);
    n++;
  }
  return n;
}

/** When a NAS last answered a poll: its row or the time of its snapshot, whichever is newer (the row is written less often). */
function lastSuccess(nas, snap) {
  const a = nas && nas.last_success_at != null ? nas.last_success_at : null;
  const b = snap && snap.fetched_at ? snap.fetched_at : null;
  return a == null ? b : (b == null ? a : Math.max(a, b));
}

// ─── GateDrop drop folders (1.2.0) ───────────────

async function listFolders(gc) {
  const { rows } = await gc.db.query('SELECT id, nas_id, label, path FROM drop_folders ORDER BY label COLLATE NOCASE, id');
  return rows;
}

async function getFolder(gc, id) {
  const { row } = await gc.db.get('SELECT id, nas_id, label, path FROM drop_folders WHERE id = ?', [id]);
  return row || null;
}

async function createFolder(gc, f) {
  const r = await gc.db.run('INSERT INTO drop_folders (nas_id, label, path) VALUES (?, ?, ?)', [f.nas_id, f.label, f.path]);
  return getFolder(gc, r.lastInsertRowid);
}

async function updateFolder(gc, id, f) {
  await gc.db.run('UPDATE drop_folders SET nas_id = ?, label = ?, path = ? WHERE id = ?', [f.nas_id, f.label, f.path, id]);
  return getFolder(gc, id);
}

async function deleteFolder(gc, id) {
  return (await gc.db.run('DELETE FROM drop_folders WHERE id = ?', [id])).changes > 0;
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
  secret, setSecret, credentials, secretKey, SECRET_KINDS, listFolders, getFolder, createFolder, updateFolder, deleteFolder, PERSIST_MS,
  flush, lastSuccess, steadyOf,
  /** Tests: forget what is kept in memory, as a restart of the plugin does (without flush: as after a crash). */
  _forget(gc) { memBy.delete(gc); },
};
