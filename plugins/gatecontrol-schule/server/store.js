'use strict';

// Data access of the plugin's own database (migrations/001_init.sql).
//
// Credentials are plugin secrets, never in this database: the QR key of an
// account under 'acct.<id>.secret', a password under 'acct.<id>.password'
// (gc.settings.setSecret — any key of the plugin's own, stored encrypted with
// the server key like a declared `secret` setting, never sent to the browser,
// re-keyed by backups; docs/plugins.md "Plugin code"). Deleting an account
// deletes them together with its students, lessons and change log.

// One transaction at a time over the host's single connection.
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

const userIds = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, 50) : []);

/** UPDATE <table> SET … WHERE id = ? for the given columns of `patch` (unknown keys ignored). */
async function patchRow(gc, table, cols, id, patch) {
  const keys = Object.keys(patch || {}).filter((k) => cols.includes(k));
  if (!keys.length) return;
  await gc.db.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => patch[k]), id]);
}

// ─── Accounts ───────────────────────────────────

const ACCOUNT_COLS = ['host', 'school', 'username', 'auth', 'person_id', 'person_type', 'status', 'last_error', 'error_count', 'last_attempt_at',
  'last_success_at', 'last_error_at', 'next_fetch_at', 'refresh_asked_at', 'timegrid_json', 'holidays_json', 'meta_day'];

function accountRow(r) {
  if (!r) return null;
  return {
    id: r.id, host: r.host, school: r.school, username: r.username, auth: r.auth,
    person_id: r.person_id == null ? null : Number(r.person_id), person_type: r.person_type == null ? null : Number(r.person_type),
    status: r.status, last_error: r.last_error || null, error_count: Number(r.error_count) || 0,
    last_attempt_at: r.last_attempt_at == null ? null : Number(r.last_attempt_at),
    last_success_at: r.last_success_at == null ? null : Number(r.last_success_at),
    last_error_at: r.last_error_at == null ? null : Number(r.last_error_at),
    next_fetch_at: Number(r.next_fetch_at) || 0, refresh_asked_at: r.refresh_asked_at == null ? null : Number(r.refresh_asked_at),
    timegrid: parseJson(r.timegrid_json, []), holidays: parseJson(r.holidays_json, []), meta_day: r.meta_day || null,
    created_at: Number(r.created_at),
  };
}

async function listAccounts(gc) {
  return (await gc.db.query('SELECT * FROM accounts ORDER BY id')).rows.map(accountRow);
}
async function getAccount(gc, id) {
  return accountRow((await gc.db.get('SELECT * FROM accounts WHERE id = ?', [id])).row);
}
async function findAccount(gc, host, school, username) {
  return accountRow((await gc.db.get('SELECT * FROM accounts WHERE host = ? AND lower(school) = lower(?) AND lower(username) = lower(?)', [host, school, username])).row);
}
async function createAccount(gc, a, now) {
  const r = await gc.db.run('INSERT INTO accounts (host, school, username, auth, created_at) VALUES (?, ?, ?, ?, ?)', [a.host, a.school, a.username, a.auth, now]);
  return getAccount(gc, r.lastInsertRowid);
}
async function updateAccount(gc, id, patch) {
  const p = { ...patch };
  if (p.timegrid !== undefined) { p.timegrid_json = JSON.stringify(p.timegrid || []); delete p.timegrid; }
  if (p.holidays !== undefined) { p.holidays_json = JSON.stringify(p.holidays || []); delete p.holidays; }
  await patchRow(gc, 'accounts', ACCOUNT_COLS, id, p);
  return getAccount(gc, id);
}

/** The account's credentials { secret } | { password } (null when missing). */
async function getCred(gc, acc) {
  const key = acc.auth === 'secret' ? 'secret' : 'password';
  let v = null;
  try { v = await gc.settings.get(`acct.${acc.id}.${key}`); } catch { v = null; }
  return typeof v === 'string' && v ? { [key]: v } : null;
}
async function setCred(gc, id, auth, value) {
  await gc.settings.setSecret(`acct.${id}.${auth === 'secret' ? 'secret' : 'password'}`, value);
  // switching the login kind drops the other credential
  await gc.settings.setSecret(`acct.${id}.${auth === 'secret' ? 'password' : 'secret'}`, null);
}
async function clearCred(gc, id) {
  for (const k of ['secret', 'password']) {
    try { await gc.settings.setSecret(`acct.${id}.${k}`, null); } catch (e) { gc.log.warn('secret not removed', id, k, (e && e.code) || 'error'); }
  }
}

/** Deletes an account with its credentials, students, lessons and change log. */
async function deleteAccount(gc, id) {
  await clearCred(gc, id);
  return tx(gc, async () => {
    const ids = (await gc.db.query('SELECT id FROM students WHERE account_id = ?', [id])).rows.map((r) => r.id);
    for (const sid of ids) {
      await gc.db.run('DELETE FROM lessons WHERE student_id = ?', [sid]);
      await gc.db.run('DELETE FROM changes WHERE student_id = ?', [sid]);
    }
    await gc.db.run('DELETE FROM students WHERE account_id = ?', [id]);
    return (await gc.db.run('DELETE FROM accounts WHERE id = ?', [id])).changes > 0;
  });
}

// ─── Students ───────────────────────────────────

const STUDENT_COLS = ['name', 'alias', 'klasse', 'enabled', 'user_id', 'recipients_json', 'show_on_wall', 'baseline_done', 'missing', 'range_from',
  'range_to', 'last_fetch_at', 'last_change_at', 'last_error'];

function studentRow(r) {
  if (!r) return null;
  return {
    id: r.id, account_id: r.account_id, person_id: Number(r.person_id), name: r.name, alias: r.alias || null,
    display: r.alias || r.name, klasse: r.klasse || '',
    enabled: !!r.enabled, user_id: r.user_id == null ? null : Number(r.user_id), recipients: userIds(parseJson(r.recipients_json, [])),
    show_on_wall: !!r.show_on_wall, baseline_done: !!r.baseline_done, missing: !!r.missing,
    range_from: r.range_from || null, range_to: r.range_to || null,
    last_fetch_at: r.last_fetch_at == null ? null : Number(r.last_fetch_at),
    last_change_at: r.last_change_at == null ? null : Number(r.last_change_at),
    last_error: r.last_error || null, created_at: Number(r.created_at),
  };
}

async function listStudents(gc, accountId) {
  const r = accountId == null
    ? await gc.db.query('SELECT * FROM students ORDER BY account_id, id')
    : await gc.db.query('SELECT * FROM students WHERE account_id = ? ORDER BY id', [accountId]);
  return r.rows.map(studentRow);
}
async function getStudent(gc, id) {
  return studentRow((await gc.db.get('SELECT * FROM students WHERE id = ?', [id])).row);
}
async function updateStudent(gc, id, patch) {
  const p = { ...patch };
  if (p.recipients !== undefined) { p.recipients_json = JSON.stringify(userIds(p.recipients)); delete p.recipients; }
  for (const k of ['enabled', 'show_on_wall', 'baseline_done', 'missing']) if (typeof p[k] === 'boolean') p[k] = p[k] ? 1 : 0;
  await patchRow(gc, 'students', STUDENT_COLS, id, p);
  return getStudent(gc, id);
}

/**
 * The students an account lists now ([{ personId, name }]): new ones are added (enabled, baseline
 * pending), names follow WebUntis, ones no longer listed are marked missing (kept, not fetched).
 */
async function syncStudents(gc, accountId, persons, now) {
  const have = await listStudents(gc, accountId);
  const byPerson = new Map(have.map((s) => [s.person_id, s]));
  const listed = new Set();
  for (const p of persons) {
    listed.add(p.personId);
    const s = byPerson.get(p.personId);
    if (!s) {
      await gc.db.run('INSERT INTO students (account_id, person_id, name, created_at) VALUES (?, ?, ?, ?)', [accountId, p.personId, p.name, now]);
    } else if (s.name !== p.name || s.missing) {
      await updateStudent(gc, s.id, { name: p.name, missing: false });
    }
  }
  for (const s of have) if (!listed.has(s.person_id) && !s.missing) await updateStudent(gc, s.id, { missing: true });
  return listStudents(gc, accountId);
}

// ─── Lessons ────────────────────────────────────

const LESSON_COLS = ['lkey', 'date', 't_start', 't_end', 'period', 'period_end', 'subject', 'subject_long', 'subject_old', 'teacher', 'teacher_old',
  'room', 'room_old', 'klasse', 'state', 'info', 'subst_text', 'lstext', 'added', 'removed'];

function lessonRow(r) {
  if (!r) return null;
  const out = {};
  for (const k of LESSON_COLS) out[k] = r[k] === undefined ? null : r[k];
  out.student_id = r.student_id;
  out.period = r.period == null ? null : Number(r.period);
  out.period_end = r.period_end == null ? null : Number(r.period_end);
  out.added = !!r.added;
  out.removed = !!r.removed;
  for (const k of ['subject', 'subject_long', 'teacher', 'room', 'klasse']) out[k] = out[k] || '';
  return out;
}

/** Lessons of students between two dates (inclusive), by date and time. */
async function lessonsBetween(gc, studentIds, from, to) {
  if (!studentIds.length) return [];
  const out = [];
  for (let i = 0; i < studentIds.length; i += 90) {
    const ids = studentIds.slice(i, i + 90);
    const r = await gc.db.query(`SELECT * FROM lessons WHERE student_id IN (${ids.map(() => '?').join(',')}) AND date >= ? AND date <= ? ORDER BY date, t_start, lkey`, [...ids, from, to]);
    out.push(...r.rows.map(lessonRow));
  }
  return out;
}

/** Replaces a student's lessons between `from` and `to` with `rows`. */
async function replaceLessons(gc, studentId, from, to, rows) {
  return tx(gc, async () => {
    await gc.db.run('DELETE FROM lessons WHERE student_id = ? AND date >= ? AND date <= ?', [studentId, from, to]);
    await insertMany(gc, `INSERT OR REPLACE INTO lessons (student_id, ${LESSON_COLS.join(', ')})`, LESSON_COLS.length + 1,
      rows.map((r) => [studentId, ...LESSON_COLS.map((k) => (k === 'added' || k === 'removed' ? (r[k] ? 1 : 0) : (r[k] === undefined ? null : r[k])))]));
  });
}

async function countLessons(gc) {
  const m = new Map();
  for (const r of (await gc.db.query('SELECT student_id, COUNT(*) AS n FROM lessons GROUP BY student_id')).rows) m.set(r.student_id, Number(r.n));
  return m;
}

// ─── Change log ─────────────────────────────────

function changeRow(r) {
  if (!r) return null;
  return {
    id: r.id, student_id: r.student_id, lkey: r.lkey, date: r.date, t_start: r.t_start, t_end: r.t_end,
    period: r.period == null ? null : Number(r.period), kind: r.kind, subject: r.subject || '', detail: parseJson(r.detail_json, {}),
    detected_at: Number(r.detected_at), status: r.status, sent_at: r.sent_at == null ? null : Number(r.sent_at),
    rule_at: r.rule_at == null ? null : Number(r.rule_at),
  };
}

async function addChanges(gc, studentId, list, now) {
  if (!list.length) return;
  await insertMany(gc, 'INSERT INTO changes (student_id, lkey, date, t_start, t_end, period, kind, subject, detail_json, detected_at, status)', 11,
    list.map((c) => [studentId, c.lkey, c.date, c.t_start, c.t_end, c.period == null ? null : c.period, c.kind, c.subject || '', JSON.stringify(c.detail || {}), now, c.status]));
}

async function changesWithStatus(gc, statuses) {
  return (await gc.db.query(`SELECT * FROM changes WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY student_id, date, t_start, id`, statuses)).rows.map(changeRow);
}

async function setChangeStatus(gc, ids, status, sentAt = null) {
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    await gc.db.run(`UPDATE changes SET status = ?, sent_at = ? WHERE id IN (${chunk.map(() => '?').join(',')})`, [status, sentAt, ...chunk]);
  }
}

/** Was a cancellation of this lesson pushed before change `beforeId`? */
/** 1.1.0: the changes handed to the Familie plugin's rules (or skipped) — never again. */
async function setRuleAt(gc, ids, at) {
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    await gc.db.run(`UPDATE changes SET rule_at = ? WHERE id IN (${chunk.map(() => '?').join(',')})`, [at, ...chunk]);
  }
}

async function cancellationSent(gc, studentId, lkey, beforeId) {
  const r = await gc.db.get("SELECT id FROM changes WHERE student_id = ? AND lkey = ? AND kind = 'cancelled' AND status = 'sent' AND id < ? LIMIT 1", [studentId, lkey, beforeId]);
  return !!r.row;
}

/** The change log of some students since `since` (ms), newest first. */
async function listChanges(gc, studentIds, since, limit = 100) {
  if (studentIds != null && !studentIds.length) return [];
  const where = studentIds == null ? '' : `student_id IN (${studentIds.map(() => '?').join(',')}) AND `;
  const r = await gc.db.query(`SELECT * FROM changes WHERE ${where}detected_at >= ? ORDER BY detected_at DESC, id DESC LIMIT ?`, [...(studentIds || []), since, limit]);
  return r.rows.map(changeRow);
}

/** Housekeeping: lessons before `beforeDate`, changes detected before `beforeMs`. */
async function prune(gc, beforeDate, beforeMs) {
  await gc.db.run('DELETE FROM lessons WHERE date < ?', [beforeDate]);
  await gc.db.run('DELETE FROM changes WHERE detected_at < ?', [beforeMs]);
}

module.exports = {
  tx, listAccounts, getAccount, findAccount, createAccount, updateAccount, deleteAccount, getCred, setCred, clearCred,
  listStudents, getStudent, updateStudent, syncStudents,
  lessonsBetween, replaceLessons, countLessons, LESSON_COLS,
  addChanges, changesWithStatus, setChangeStatus, setRuleAt, cancellationSent, listChanges, prune,
};
