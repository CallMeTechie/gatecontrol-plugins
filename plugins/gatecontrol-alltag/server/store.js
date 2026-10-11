'use strict';

// Data access of the plugin's own database (migrations/001_init.sql).
// Calendar secrets (the internet address, Basic-auth credentials) are
// plugin secrets (gc.settings.setSecret 'sub.<id>.url' / '.user' /
// '.password'): encrypted by the host, never sent to the browser, never in
// this database.

function codeError(code) { return Object.assign(new Error(code), { code }); }

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

function parseJson(s, fallback) {
  if (typeof s !== 'string' || !s) return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
}

/** Multi-row INSERT in chunks (the host takes at most 100 parameters per statement). */
async function insertMany(gc, sql, cols, rows) {
  const per = Math.max(1, Math.floor(100 / cols));
  const tuple = '(' + new Array(cols).fill('?').join(',') + ')';
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    await gc.db.run(sql + ' VALUES ' + chunk.map(() => tuple).join(','), chunk.flat());
  }
}

const userIds = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, 500) : null);

// ─── Plans ──────────────────────────────────────

const PLAN_COLS = `id, name, source, provider, provider_config, ics_name, rules_json, exceptions_json, users_json, enabled, status,
  last_error, error_count, last_attempt_at, last_success_at, next_refresh_at, created_at, updated_at,
  CASE WHEN ics_text IS NULL THEN 0 ELSE length(ics_text) END AS ics_size`;

function planRow(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, source: r.source, provider: r.provider || null,
    provider_config: parseJson(r.provider_config, null), ics_name: r.ics_name || null, ics_size: r.ics_size || 0,
    rules: parseJson(r.rules_json, []), exceptions: parseJson(r.exceptions_json, []),
    users: r.users_json == null ? null : userIds(parseJson(r.users_json, [])) || [],
    enabled: !!r.enabled, status: r.status, last_error: r.last_error || null, error_count: r.error_count || 0,
    last_attempt_at: r.last_attempt_at || null, last_success_at: r.last_success_at || null, next_refresh_at: r.next_refresh_at || 0,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

async function listPlans(gc) {
  return (await gc.db.query(`SELECT ${PLAN_COLS} FROM plans ORDER BY id`)).rows.map(planRow);
}

async function getPlan(gc, id) {
  return planRow((await gc.db.get(`SELECT ${PLAN_COLS} FROM plans WHERE id = ?`, [Number(id)])).row);
}

async function planIcs(gc, id) {
  const r = (await gc.db.get('SELECT ics_text FROM plans WHERE id = ?', [Number(id)])).row;
  return r && typeof r.ics_text === 'string' ? r.ics_text : null;
}

async function createPlan(gc, p) {
  const r = await gc.db.run(
    `INSERT INTO plans (name, source, provider, provider_config, ics_text, ics_name, rules_json, exceptions_json, users_json, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [p.name, p.source, p.provider || null, p.provider_config ? JSON.stringify(p.provider_config) : null, p.ics_text || null, p.ics_name || null,
      JSON.stringify(p.rules || []), JSON.stringify(p.exceptions || []), p.users == null ? null : JSON.stringify(userIds(p.users) || []), p.enabled === false ? 0 : 1]);
  return getPlan(gc, r.lastInsertRowid);
}

const PLAN_FIELDS = {
  name: (v) => v,
  source: (v) => v,
  provider: (v) => v || null,
  provider_config: (v) => (v ? JSON.stringify(v) : null),
  ics_text: (v) => v || null,
  ics_name: (v) => v || null,
  rules: (v) => JSON.stringify(v || []),
  exceptions: (v) => JSON.stringify(v || []),
  users: (v) => (v == null ? null : JSON.stringify(userIds(v) || [])),
  enabled: (v) => (v ? 1 : 0),
  status: (v) => v,
  last_error: (v) => v || null,
  error_count: (v) => Number(v) || 0,
  last_attempt_at: (v) => v || null,
  last_success_at: (v) => v || null,
  next_refresh_at: (v) => Number(v) || 0,
};
const PLAN_COLUMN = { rules: 'rules_json', exceptions: 'exceptions_json', users: 'users_json' };

async function updatePlan(gc, id, patch) {
  const sets = []; const vals = [];
  for (const [k, fn] of Object.entries(PLAN_FIELDS)) {
    if (!(k in patch)) continue;
    sets.push(`${PLAN_COLUMN[k] || k} = ?`);
    vals.push(fn(patch[k]));
  }
  if (sets.length) await gc.db.run(`UPDATE plans SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...vals, Number(id)]);
  return getPlan(gc, id);
}

async function deletePlan(gc, id) {
  return tx(gc, async () => {
    await gc.db.run('DELETE FROM waste_dates WHERE plan_id = ?', [Number(id)]);
    await gc.db.run('DELETE FROM fractions WHERE plan_id = ?', [Number(id)]);
    return (await gc.db.run('DELETE FROM plans WHERE id = ?', [Number(id)])).changes > 0;
  });
}

// ─── Fractions and dates ────────────────────────

async function listFractions(gc, planId) {
  const sql = planId == null ? 'SELECT * FROM fractions ORDER BY plan_id, id' : 'SELECT * FROM fractions WHERE plan_id = ? ORDER BY id';
  return (await gc.db.query(sql, planId == null ? [] : [Number(planId)])).rows;
}

/**
 * The fraction ids for these source names (missing ones are created with
 * the keyword type). entries: [{ key, name, type, color }] → Map(key → id).
 */
async function ensureFractions(gc, planId, entries) {
  const have = new Map((await listFractions(gc, planId)).map((f) => [f.source_key, f]));
  for (const e of entries) {
    const f = have.get(e.key);
    if (!f) {
      const r = await gc.db.run('INSERT INTO fractions (plan_id, source_key, source_name, source_color, type) VALUES (?, ?, ?, ?, ?)',
        [Number(planId), e.key, e.name, e.color || null, e.type]);
      have.set(e.key, { id: r.lastInsertRowid, source_key: e.key });
    } else if (e.color && f.source_color !== e.color) {
      await gc.db.run('UPDATE fractions SET source_color = ? WHERE id = ?', [e.color, f.id]);
    }
  }
  return new Map([...have].map(([k, f]) => [k, f.id]));
}

async function updateFraction(gc, planId, id, patch) {
  const sets = []; const vals = [];
  if ('name' in patch) { sets.push('name = ?'); vals.push(patch.name || null); }
  if ('color' in patch) { sets.push('color = ?'); vals.push(patch.color || null); }
  if ('type' in patch) { sets.push('type = ?'); vals.push(patch.type); }
  if ('hidden' in patch) { sets.push('hidden = ?'); vals.push(patch.hidden ? 1 : 0); }
  if (!sets.length) return null;
  const r = await gc.db.run(`UPDATE fractions SET ${sets.join(', ')} WHERE id = ? AND plan_id = ?`, [...vals, Number(id), Number(planId)]);
  if (!r.changes) throw codeError('NOT_FOUND');
  return (await gc.db.get('SELECT * FROM fractions WHERE id = ?', [Number(id)])).row;
}

/** Replace the stored dates of a plan (the last good result). rows: [{ date, fraction_id }] */
async function replaceDates(gc, planId, rows) {
  return tx(gc, async () => {
    await gc.db.run('DELETE FROM waste_dates WHERE plan_id = ?', [Number(planId)]);
    const uniq = new Map(rows.map((r) => [`${r.date}|${r.fraction_id}`, [Number(planId), r.date, r.fraction_id]]));
    await insertMany(gc, 'INSERT INTO waste_dates (plan_id, date, fraction_id)', 3, [...uniq.values()]);
  });
}

/** Stored dates of a plan (or all plans) within [from, to] with their fraction. */
async function datesBetween(gc, planId, from, to) {
  const where = planId == null ? '' : 'd.plan_id = ? AND ';
  return (await gc.db.query(
    `SELECT d.plan_id, d.date, f.id AS fraction_id, f.source_name, f.source_color, f.type, f.name, f.color, f.hidden
       FROM waste_dates d JOIN fractions f ON f.id = d.fraction_id
      WHERE ${where}d.date >= ? AND d.date <= ? ORDER BY d.date, f.id`,
    planId == null ? [from, to] : [Number(planId), from, to])).rows;
}

async function countDates(gc, planId, from) {
  return (await gc.db.get('SELECT COUNT(*) AS n FROM waste_dates WHERE plan_id = ? AND date >= ?', [Number(planId), from])).row.n;
}

// ─── Calendar subscriptions ─────────────────────

function subRow(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, color: r.color, source: r.source, url_host: r.url_host || null,
    target_index: r.target_index == null ? null : r.target_index, target_path: r.target_path || null,
    reminder: r.reminder, allday_reminder: !!r.allday_reminder, users: userIds(parseJson(r.users_json, [])) || [],
    created_by: r.created_by || null, enabled: !!r.enabled, status: r.status, last_error: r.last_error || null, error_count: r.error_count || 0,
    etag: r.etag || null, last_modified: r.last_modified || null, last_attempt_at: r.last_attempt_at || null,
    last_success_at: r.last_success_at || null, last_parsed_at: r.last_parsed_at || null, next_refresh_at: r.next_refresh_at || 0,
    event_count: r.event_count || 0, truncated: !!r.truncated, created_at: r.created_at, updated_at: r.updated_at,
  };
}

async function listSubs(gc) {
  return (await gc.db.query('SELECT * FROM subscriptions ORDER BY id')).rows.map(subRow);
}

async function getSub(gc, id) {
  return subRow((await gc.db.get('SELECT * FROM subscriptions WHERE id = ?', [Number(id)])).row);
}

async function createSub(gc, s) {
  const r = await gc.db.run(
    `INSERT INTO subscriptions (name, color, source, url_host, target_index, target_path, reminder, allday_reminder, users_json, created_by, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [s.name, s.color, s.source, s.url_host || null, s.target_index == null ? null : s.target_index, s.target_path || null,
      s.reminder, s.allday_reminder ? 1 : 0, JSON.stringify(userIds(s.users) || []), s.created_by || null, s.enabled === false ? 0 : 1]);
  return getSub(gc, r.lastInsertRowid);
}

const SUB_FIELDS = ['name', 'color', 'source', 'url_host', 'target_index', 'target_path', 'reminder', 'allday_reminder', 'users', 'enabled', 'status',
  'last_error', 'error_count', 'etag', 'last_modified', 'last_attempt_at', 'last_success_at', 'last_parsed_at', 'next_refresh_at', 'event_count', 'truncated'];

async function updateSub(gc, id, patch) {
  const sets = []; const vals = [];
  for (const k of SUB_FIELDS) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if (k === 'users') { sets.push('users_json = ?'); vals.push(JSON.stringify(userIds(v) || [])); continue; }
    if (typeof v === 'boolean') v = v ? 1 : 0;
    sets.push(`${k} = ?`);
    vals.push(v === undefined ? null : v);
  }
  if (sets.length) await gc.db.run(`UPDATE subscriptions SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...vals, Number(id)]);
  return getSub(gc, id);
}

async function deleteSub(gc, id) {
  return tx(gc, async () => {
    await gc.db.run('DELETE FROM events WHERE sub_id = ?', [Number(id)]);
    return (await gc.db.run('DELETE FROM subscriptions WHERE id = ?', [Number(id)])).changes > 0;
  });
}

/** Replace the stored instances of a subscription. */
async function replaceEvents(gc, subId, instances) {
  return tx(gc, async () => {
    await gc.db.run('DELETE FROM events WHERE sub_id = ?', [Number(subId)]);
    const seen = new Set();
    const rows = [];
    for (const i of instances) {
      if (seen.has(i.key)) continue;
      seen.add(i.key);
      rows.push([Number(subId), i.key.slice(0, 600), i.title || '', i.location || null, i.allDay ? 1 : 0, i.start, i.end, i.date, i.endDate || null]);
    }
    await insertMany(gc, 'INSERT INTO events (sub_id, ikey, title, location, all_day, start_ms, end_ms, date, end_date)', 9, rows);
  });
}

/** Instances of these subscriptions overlapping [from, to) (ms). */
async function eventsBetween(gc, subIds, from, to, limit = 500) {
  const ids = (subIds || []).filter((x) => Number.isSafeInteger(x));
  if (!ids.length) return [];
  return (await gc.db.query(
    `SELECT sub_id, ikey, title, location, all_day, start_ms, end_ms, date, end_date FROM events
      WHERE sub_id IN (${ids.map(() => '?').join(',')}) AND start_ms < ? AND (end_ms > ? OR start_ms >= ?)
      ORDER BY start_ms, all_day DESC, title LIMIT ?`,
    [...ids, to, from, from, limit])).rows.map((r) => ({ ...r, all_day: !!r.all_day }));
}

// ─── Subscription secrets ───────────────────────

const secretKey = (id, what) => `sub.${Number(id)}.${what}`;

async function subSecret(gc, id, what) {
  const v = await gc.settings.get(secretKey(id, what));
  return typeof v === 'string' && v ? v : null;
}

async function setSubSecret(gc, id, what, value) {
  await gc.settings.setSecret(secretKey(id, what), value == null || value === '' ? null : String(value));
}

async function clearSubSecrets(gc, id) {
  for (const w of ['url', 'user', 'password']) await setSubSecret(gc, id, w, null);
}

module.exports = {
  tx, parseJson, insertMany, userIds, codeError,
  listPlans, getPlan, planIcs, createPlan, updatePlan, deletePlan,
  listFractions, ensureFractions, updateFraction, replaceDates, datesBetween, countDates,
  listSubs, getSub, createSub, updateSub, deleteSub, replaceEvents, eventsBetween,
  subSecret, setSubSecret, clearSubSecrets, secretKey,
};
